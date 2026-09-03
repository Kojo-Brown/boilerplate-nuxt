import { EventEmitter, getEventListeners } from 'node:events'

import type { H3Event } from 'h3'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

import {
  DEFAULT_RETRY_MS,
  HEARTBEAT_COMMENT,
  MAX_RESUME_TOKEN_LENGTH,
  SSE_CONTENT_TYPE,
  encodeSseBlock,
  encodeSseComment,
  parseResumeToken,
  resumeFrom,
  sendSse,
  sseBlocks,
  sseErrorBlock,
  withHeartbeat,
} from '~/server/utils/sse'
import { STREAM_RESPONSE_HEADERS, abortableDelay } from '~/server/utils/stream'
import { SSE_DONE_EVENT, SSE_ERROR_EVENT, type SseMessage } from '~/types/sse'

/**
 * What is asserted here is the three things SSE needs that a byte stream does
 * not give it: a framing whose rules cannot be broken by the values put through
 * it, a keepalive that is emitted *while the source is being awaited*, and a
 * source that is told exactly once when the client goes away.
 *
 * The heartbeat tests are the reason this file exists. The property that matters
 * is not "a beat appears" — a wrong implementation produces those too — it is
 * that beats do not consume the source. `withHeartbeat` races the pending
 * `next()` against a timer, and the version of that race which asks the source
 * again on every tick passes any test that only counts output.
 *
 * `sendStream`, `setResponseHeader`, `getRequestHeader` and `getQuery` are Nitro
 * auto-imports, stubbed rather than imported so these tests do not boot a Nitro
 * app. All four are called at request time, so a `stubGlobal` here is early
 * enough.
 */

/** A minimal `ServerResponse` — the three members the disconnect logic reads. */
class FakeResponse extends EventEmitter {
  writableEnded = false
  destroyed = false
}

let sentStreams: ReadableStream<Uint8Array>[]
let headers: Record<string, string>
let requestHeaders: Record<string, string>
let requestQuery: Record<string, unknown>

beforeEach(() => {
  sentStreams = []
  headers = {}
  requestHeaders = {}
  requestQuery = {}

  vi.stubGlobal('setResponseHeader', (_event: H3Event, name: string, value: string) => {
    headers[name] = value
  })
  vi.stubGlobal('sendStream', (_event: H3Event, stream: ReadableStream<Uint8Array>) => {
    sentStreams.push(stream)
    return Promise.resolve()
  })
  vi.stubGlobal(
    'getRequestHeader',
    (_event: H3Event, name: string) => requestHeaders[name.toLowerCase()],
  )
  vi.stubGlobal('getQuery', () => requestQuery)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/** A fresh event per call, so response `close` listeners do not accumulate. */
function createEvent(): H3Event {
  return { node: { res: new FakeResponse() } } as unknown as H3Event
}

/** Collects a stream into the text it wrote. */
async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder()
  let text = ''
  for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
    text += decoder.decode(chunk, { stream: true })
  }
  return text + decoder.decode()
}

describe('encodeSseBlock', () => {
  it('writes the fields in a stable order and terminates with a blank line', () => {
    expect(encodeSseBlock({ event: 'tick', id: '7', retryMs: 1000, data: '{"seq":7}' })).toBe(
      'event: tick\nid: 7\nretry: 1000\ndata: {"seq":7}\n\n',
    )
  })

  it('dispatches as the default `message` event when no name is given', () => {
    expect(encodeSseBlock({ data: 'hello' })).toBe('data: hello\n\n')
  })

  it('splits multi-line data into one `data:` line each', () => {
    // The client rejoins these with `\n`, so this is how a payload containing a
    // newline survives a framing whose record separator is a blank line.
    expect(encodeSseBlock({ data: 'first\nsecond\nthird' })).toBe(
      'data: first\ndata: second\ndata: third\n\n',
    )
  })

  it('treats `\\r\\n` and a bare `\\r` as line terminators too', () => {
    // SSE recognises all three. Splitting on `\n` alone leaves a stray `\r` at
    // the end of a field value, which `JSON.parse` rejects on the client for a
    // reason nothing in the response explains.
    expect(encodeSseBlock({ data: 'a\r\nb\rc' })).toBe('data: a\ndata: b\ndata: c\n\n')
  })

  it('writes a bare `data:` for an empty line rather than trailing whitespace', () => {
    expect(encodeSseBlock({ data: '' })).toBe('data:\n\n')
    expect(encodeSseBlock({ data: 'a\n\nb' })).toBe('data: a\ndata:\ndata: b\n\n')
  })

  it('encodes a retry-only block, which sets the delay and dispatches nothing', () => {
    expect(encodeSseBlock({ retryMs: 3000 })).toBe('retry: 3000\n\n')
  })

  it('encodes an empty block as nothing at all', () => {
    expect(encodeSseBlock({})).toBe('')
  })

  it.each([
    ['a newline', 'one\ntwo'],
    ['a carriage return', 'one\rtwo'],
    ['a NUL', 'one\0two'],
  ])('rejects an id containing %s', (_label, value) => {
    // Framing injection: a `\n` in an id lets the value write its own fields,
    // including a `data:` line. A NUL makes the client ignore the id, which
    // breaks resumption with no error anywhere.
    expect(() => encodeSseBlock({ id: value, data: 'x' })).toThrow(TypeError)
  })

  it('rejects an event name containing a line terminator', () => {
    expect(() => encodeSseBlock({ event: 'a\nb', data: 'x' })).toThrow(TypeError)
  })

  it.each([
    ['a fraction', 1000.5],
    ['a negative', -1],
    ['NaN', Number.NaN],
  ])('rejects a retry that is %s', (_label, value) => {
    // The client parses `retry` as ASCII digits and ignores the field
    // otherwise, so `retry: 1000.5` is no reconnection delay rather than one
    // that got rounded.
    expect(() => encodeSseBlock({ retryMs: value })).toThrow(TypeError)
  })

  it('allows a line terminator inside data, which is the field that can carry one', () => {
    expect(() => encodeSseBlock({ data: 'safe\nenough' })).not.toThrow()
  })
})

describe('encodeSseComment', () => {
  it('writes a comment the client is required to ignore', () => {
    expect(encodeSseComment('ping')).toBe(': ping\n\n')
  })

  it('prefixes every line of a multi-line comment', () => {
    // Without the per-line prefix the second line parses as a field, so a
    // comment could dispatch an event.
    expect(encodeSseComment('one\ntwo')).toBe(': one\n: two\n\n')
  })
})

/** An async iterable whose `next()` calls are resolved by the test, one by one. */
function manualSource() {
  const waiting: ((result: IteratorResult<string>) => void)[] = []
  const state = { entered: 0, returned: 0 }

  const iterable: AsyncIterable<string> = {
    [Symbol.asyncIterator]() {
      return {
        next() {
          state.entered++
          return new Promise<IteratorResult<string>>((resolve) => waiting.push(resolve))
        },
        return() {
          state.returned++
          return Promise.resolve({ done: true, value: undefined })
        },
      }
    },
  }

  return {
    state,
    iterable,
    /** Settles the oldest outstanding `next()`. */
    deliver(value: string) {
      waiting.shift()?.({ done: false, value })
    },
    finish() {
      waiting.shift()?.({ done: true, value: undefined })
    },
  }
}

/** Drains a generator in the background and exposes what it has produced. */
function collect(source: AsyncIterable<string>) {
  const chunks: string[] = []
  const done = (async () => {
    for await (const chunk of source) chunks.push(chunk)
  })()
  return { chunks, done }
}

describe('withHeartbeat', () => {
  it('passes the source through unchanged when nothing is idle', async () => {
    async function* source(): AsyncGenerator<string> {
      yield 'a'
      yield 'b'
    }

    const { chunks, done } = collect(withHeartbeat(source(), { intervalMs: 10_000 }))
    await done

    expect(chunks).toEqual(['a', 'b'])
  })

  it('emits a beat for every idle interval while the source is still pending', async () => {
    vi.useFakeTimers()
    const source = manualSource()
    const { chunks } = collect(withHeartbeat(source.iterable, { intervalMs: 100 }))

    await vi.advanceTimersByTimeAsync(350)

    expect(chunks).toEqual([
      `: ${HEARTBEAT_COMMENT}\n\n`,
      `: ${HEARTBEAT_COMMENT}\n\n`,
      `: ${HEARTBEAT_COMMENT}\n\n`,
    ])
  })

  it('does not ask the source again while a `next()` is still outstanding', async () => {
    // The property the whole implementation is shaped around. A race that calls
    // `next()` on each tick queues concurrent requests against the source: for
    // an async generator that means the value this loop is waiting for is
    // handed to a call whose result is discarded, and a cursor-backed source
    // advances once per beat rather than once per delivered row. Counting the
    // output cannot see it — the beats look identical either way.
    vi.useFakeTimers()
    const source = manualSource()
    const { chunks } = collect(withHeartbeat(source.iterable, { intervalMs: 100 }))

    await vi.advanceTimersByTimeAsync(500)

    expect(source.state.entered).toBe(1)
    expect(chunks).toHaveLength(5)

    source.deliver('first')
    await vi.advanceTimersByTimeAsync(0)

    expect(chunks.at(-1)).toBe('first')
    expect(source.state.entered).toBe(2)
  })

  it('measures the idle gap from the last chunk, not from the start', async () => {
    // A heartbeat exists to prove liveness when there is no data. One sent 10ms
    // after a real message proves nothing the message did not already prove.
    vi.useFakeTimers()
    const source = manualSource()
    const { chunks } = collect(withHeartbeat(source.iterable, { intervalMs: 100 }))

    await vi.advanceTimersByTimeAsync(90)
    source.deliver('a')
    await vi.advanceTimersByTimeAsync(90)

    expect(chunks).toEqual(['a'])
  })

  it('calls the source `return()` exactly once when the consumer stops early', async () => {
    const source = manualSource()
    const stream = withHeartbeat(source.iterable, { intervalMs: 10_000 })

    // The generator body does not run until it is pulled, so the `next()` has
    // to be outstanding before there is anything for `deliver` to settle.
    const pending = stream.next()
    source.deliver('a')
    expect((await pending).value).toBe('a')

    await stream.return(undefined)

    expect(source.state.returned).toBe(1)
  })

  it('ends and releases the source when the client disconnects', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const source = manualSource()
    const { chunks, done } = collect(
      withHeartbeat(source.iterable, { intervalMs: 100, signal: controller.signal }),
    )

    await vi.advanceTimersByTimeAsync(250)
    expect(chunks).toHaveLength(2)

    controller.abort()
    await done

    expect(source.state.returned).toBe(1)
    // Nothing was written after the abort: a beat onto a dead socket is the
    // thing the signal exists to prevent.
    expect(chunks).toHaveLength(2)
  })

  it('does not accumulate abort listeners across messages', async () => {
    // One timer is created per message. Without `cancellableDelay`'s `cancel`,
    // each of them leaves an `abort` listener attached for the life of the
    // request, which on a long stream is a leak and a
    // `MaxListenersExceededWarning` — and CI runs with `--throw-deprecation`.
    const controller = new AbortController()

    async function* source(): AsyncGenerator<string> {
      for (let i = 0; i < 50; i++) yield `chunk ${i}`
    }

    const { done } = collect(
      withHeartbeat(source(), { intervalMs: 10_000, signal: controller.signal }),
    )
    await done

    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
  })

  it('passes through and still cleans up when the heartbeat is disabled', async () => {
    const source = manualSource()
    const stream = withHeartbeat(source.iterable, { intervalMs: 0 })

    const pending = stream.next()
    source.deliver('a')
    expect((await pending).value).toBe('a')

    await stream.return(undefined)
    expect(source.state.returned).toBe(1)
  })

  it('accepts a custom beat', async () => {
    vi.useFakeTimers()
    const source = manualSource()
    const { chunks } = collect(
      withHeartbeat(source.iterable, { intervalMs: 100, beat: () => ': alive\n\n' }),
    )

    await vi.advanceTimersByTimeAsync(150)

    expect(chunks).toEqual([': alive\n\n'])
  })

  it('propagates a throw from the source after the beats it produced', async () => {
    async function* failing(): AsyncGenerator<string> {
      yield 'a'
      throw new Error('source failed')
    }

    const stream = withHeartbeat(failing(), { intervalMs: 10_000 })

    expect((await stream.next()).value).toBe('a')
    await expect(stream.next()).rejects.toThrow('source failed')
  })
})

describe('parseResumeToken', () => {
  it('accepts a plain token', () => {
    expect(parseResumeToken('42')).toBe('42')
  })

  it('trims surrounding whitespace', () => {
    expect(parseResumeToken('  42  ')).toBe('42')
  })

  it.each([
    ['undefined', undefined],
    ['a non-string', 42],
    ['an empty string', ''],
    ['whitespace only', '   '],
  ])('rejects %s', (_label, value) => {
    expect(parseResumeToken(value)).toBeNull()
  })

  it('rejects a token longer than the bound', () => {
    expect(parseResumeToken('a'.repeat(MAX_RESUME_TOKEN_LENGTH))).not.toBeNull()
    expect(parseResumeToken('a'.repeat(MAX_RESUME_TOKEN_LENGTH + 1))).toBeNull()
  })

  it('rejects a token that could break the framing it is written back into', () => {
    // A resume token is echoed into an `id:` line by any handler that resumes
    // from it, so the rule that protects `encodeSseBlock` has to be applied at
    // the point the value enters, not only where it leaves.
    expect(parseResumeToken('4\ndata: injected')).toBeNull()
    expect(parseResumeToken('4\0')).toBeNull()
  })
})

describe('resumeFrom', () => {
  it('reads the header the browser sends on reconnect', () => {
    requestHeaders['last-event-id'] = '17'
    expect(resumeFrom(createEvent())).toBe('17')
  })

  it('falls back to the query for clients that cannot set headers', () => {
    // `EventSource` has no API for request headers at all, so a client resuming
    // from a stored position rather than from this tab's has no other way.
    requestQuery = { lastEventId: '17' }
    expect(resumeFrom(createEvent())).toBe('17')
  })

  it('prefers the header over the query', () => {
    requestHeaders['last-event-id'] = 'header'
    requestQuery = { lastEventId: 'query' }
    expect(resumeFrom(createEvent())).toBe('header')
  })

  it('is null for a fresh connection', () => {
    expect(resumeFrom(createEvent())).toBeNull()
  })

  it('falls through to the query when the header is unusable', () => {
    requestHeaders['last-event-id'] = '   '
    requestQuery = { lastEventId: '17' }
    expect(resumeFrom(createEvent())).toBe('17')
  })
})

describe('sseBlocks', () => {
  async function* messages(): AsyncGenerator<SseMessage<{ n: number }>> {
    yield { event: 'tick', id: '1', data: { n: 1 } }
    yield { event: 'tick', id: '2', data: { n: 2 } }
  }

  it('opens with the reconnection delay and closes with a done event', async () => {
    const { chunks } = collect(sseBlocks(messages(), DEFAULT_RETRY_MS))
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(chunks[0]).toBe(`retry: ${DEFAULT_RETRY_MS}\n\n`)
    expect(chunks[1]).toBe('event: tick\nid: 1\ndata: {"n":1}\n\n')
    expect(chunks.at(-1)).toContain(`event: ${SSE_DONE_EVENT}`)
  })

  it('reports how many messages the connection delivered', async () => {
    const chunks: string[] = []
    for await (const chunk of sseBlocks(messages(), DEFAULT_RETRY_MS)) chunks.push(chunk)

    const done = JSON.parse(chunks.at(-1)!.split('data: ')[1]!.trim()) as {
      count: number
      elapsedMs: number
    }
    expect(done.count).toBe(2)
    expect(done.elapsedMs).toBeGreaterThanOrEqual(0)
  })

  it('encodes an undefined payload as JSON null rather than omitting the data line', async () => {
    // `JSON.stringify(undefined)` is `undefined`, not a string. Passing it
    // straight through encodes a block with no `data:` line, which the client
    // does not dispatch at all — a message that looks delivered and is not.
    async function* undefinedData(): AsyncGenerator<SseMessage<undefined>> {
      yield { event: 'tick', data: undefined }
    }

    const chunks: string[] = []
    for await (const chunk of sseBlocks(undefinedData(), DEFAULT_RETRY_MS)) chunks.push(chunk)

    expect(chunks[1]).toBe('event: tick\ndata: null\n\n')
  })

  it('does not emit the terminator when the consumer stops early', async () => {
    // A `done` written after the client has gone is a write onto a dead socket,
    // and a `done` written into a stream that was cut short would be a lie.
    const stream = sseBlocks(messages(), DEFAULT_RETRY_MS)
    await stream.next()
    await stream.next()
    const last = await stream.return(undefined)

    expect(last.done).toBe(true)
  })
})

describe('sseErrorBlock', () => {
  it('reports a constant message and logs the real error', () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const block = sseErrorBlock(new Error('connection string leaked in here'))

    expect(block).toContain(`event: ${SSE_ERROR_EVENT}`)
    expect(block).not.toContain('connection string')
    expect(logged).toHaveBeenCalledOnce()
  })
})

describe('sendSse', () => {
  it('applies the event-stream content type and the anti-buffering headers', async () => {
    async function* nothing(): AsyncGenerator<SseMessage<number>> {}

    await sendSse(createEvent(), nothing())

    expect(headers['content-type']).toBe(SSE_CONTENT_TYPE)
    // A proxy that buffers turns a stream back into one late response, and a
    // cached event stream is a contradiction.
    expect(headers).toMatchObject(STREAM_RESPONSE_HEADERS)
  })

  it('writes a complete, parseable event stream', async () => {
    async function* ticks(): AsyncGenerator<SseMessage<{ seq: number }>> {
      yield { event: 'tick', id: '1', data: { seq: 1 } }
    }

    await sendSse(createEvent(), ticks(), { heartbeatMs: 0 })
    const body = await readAll(sentStreams[0]!)

    // Split on the blank line that separates blocks — the framing the client
    // parses by. The trailing entry is what follows the final separator, which
    // for a well-formed stream is nothing.
    const blocks = body.split('\n\n')

    expect(blocks[0]).toBe(`retry: ${DEFAULT_RETRY_MS}`)
    expect(blocks[1]).toBe('event: tick\nid: 1\ndata: {"seq":1}')
    expect(blocks[2]).toMatch(
      new RegExp(`^event: ${SSE_DONE_EVENT}\\ndata: \\{"count":1,"elapsedMs":\\d+\\}$`),
    )
    expect(blocks[3]).toBe('')
    expect(blocks).toHaveLength(4)
  })

  it('reports a mid-stream failure as an event, since the status code has gone', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})

    async function* failing(): AsyncGenerator<SseMessage<number>> {
      yield { event: 'tick', id: '1', data: 1 }
      throw new Error('source failed')
    }

    await sendSse(createEvent(), failing(), { heartbeatMs: 0 })
    const body = await readAll(sentStreams[0]!)

    expect(body).toContain('event: tick')
    expect(body).toContain(`event: ${SSE_ERROR_EVENT}`)
    // The stream failed, so it never reached its terminator.
    expect(body).not.toContain(`event: ${SSE_DONE_EVENT}`)
  })

  it('stops the source and the stream when the client disconnects', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const state = { returned: false }

    /**
     * The shape `server/api/streaming/events.get.ts` uses, and the reason the
     * signal goes to both halves. A source that sleeps on a bare `setTimeout`
     * instead of {@link abortableDelay} cannot be cancelled here at all: an
     * async generator queues `return()` behind a pending `next()`, so the
     * cleanup would not run until the sleep it is trying to interrupt had
     * already elapsed.
     */
    async function* forever(signal: AbortSignal): AsyncGenerator<SseMessage<number>> {
      try {
        for (let seq = 1; ; seq++) {
          await abortableDelay(1_000, signal)
          if (signal.aborted) return
          yield { event: 'tick', id: String(seq), data: seq }
        }
      } finally {
        state.returned = true
      }
    }

    await sendSse(createEvent(), forever(controller.signal), {
      signal: controller.signal,
      heartbeatMs: 100,
    })
    const reader = sentStreams[0]!.getReader()

    // The opening `retry` block, then keepalives while the source sleeps.
    expect(new TextDecoder().decode((await reader.read()).value)).toBe(
      `retry: ${DEFAULT_RETRY_MS}\n\n`,
    )
    const beat = reader.read()
    await vi.advanceTimersByTimeAsync(100)
    expect(new TextDecoder().decode((await beat).value)).toBe(`: ${HEARTBEAT_COMMENT}\n\n`)

    controller.abort()
    await vi.advanceTimersByTimeAsync(0)

    expect((await reader.read()).done).toBe(true)
    expect(state.returned).toBe(true)
  })
})
