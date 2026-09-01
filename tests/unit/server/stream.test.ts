import { EventEmitter } from 'node:events'

import type { H3Event } from 'h3'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

import {
  CLIENT_DISCONNECTED,
  NDJSON_CONTENT_TYPE,
  PROGRESSIVE_HTML_CONTENT_TYPE,
  STREAM_RESPONSE_HEADERS,
  abortSignalForResponse,
  abortableDelay,
  applyStreamHeaders,
  encodeFrame,
  escapeHtml,
  htmlErrorChunk,
  ndjsonFrames,
  sendNdjson,
  sendProgressiveHtml,
  streamErrorFrame,
  streamFromIterable,
  type ClosableResponse,
} from '~/server/utils/stream'
import type { StreamFrame } from '~/types/streaming'
import { parseNdjson } from '~/utils/ndjson'

/**
 * What is asserted here is the behaviour `sendStream` does not provide, because
 * that is all this module is: cancellation, in-band failure, the headers that
 * keep an intermediary from undoing the streaming, and a source that is entered
 * once per consumed value rather than drained up front.
 *
 * `sendStream` and `setResponseHeader` are Nitro auto-imports. They are stubbed
 * rather than imported so the tests do not boot a Nitro app; both are called at
 * request time, not module-evaluation time, so a `stubGlobal` in this file is
 * early enough (unlike `defineEventHandler`, which `tests/setup.ts` has to
 * stub because it wraps at import).
 */

/** A minimal `ServerResponse` — the three members the disconnect logic reads. */
class FakeResponse extends EventEmitter implements ClosableResponse {
  writableEnded = false
  destroyed = false

  /** The response completing normally: `writableEnded` first, then `close`. */
  end(): void {
    this.writableEnded = true
    this.emit('close')
  }

  /** The connection going away mid-response. */
  disconnect(): void {
    this.destroyed = true
    this.emit('close')
  }
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

/** An async iterable over fixed values, recording whether it was cleaned up. */
function trackedSource(values: readonly string[]) {
  const state = { yielded: 0, returned: false }

  async function* generate(): AsyncGenerator<string> {
    try {
      for (const value of values) {
        state.yielded++
        yield value
      }
    } finally {
      state.returned = true
    }
  }

  return { state, iterable: generate() }
}

let sentStreams: ReadableStream<Uint8Array>[]
let headers: Record<string, string>

beforeEach(() => {
  sentStreams = []
  headers = {}

  vi.stubGlobal('setResponseHeader', (_event: H3Event, name: string, value: string) => {
    headers[name] = value
  })
  vi.stubGlobal('sendStream', (_event: H3Event, stream: ReadableStream<Uint8Array>) => {
    sentStreams.push(stream)
    return Promise.resolve()
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/**
 * A fresh event per call. The `send*` helpers register a `close` listener on the
 * response when no signal is passed, so sharing one would accumulate them and
 * eventually trip Node's max-listeners warning — which, with
 * `NODE_OPTIONS=--throw-deprecation` in CI, is not a warning.
 */
function createEvent(): H3Event {
  return { node: { res: new FakeResponse() } } as unknown as H3Event
}

describe('abortSignalForResponse', () => {
  it('does not abort when the response ends normally', () => {
    const res = new FakeResponse()
    const signal = abortSignalForResponse(res)

    res.end()

    expect(signal.aborted).toBe(false)
  })

  it('aborts when the connection closes before the response finished', () => {
    const res = new FakeResponse()
    const signal = abortSignalForResponse(res)

    res.disconnect()

    expect(signal.aborted).toBe(true)
    expect((signal.reason as Error).message).toBe(CLIENT_DISCONNECTED)
  })

  it('aborts immediately for a response that is already destroyed', () => {
    const res = new FakeResponse()
    res.destroyed = true

    expect(abortSignalForResponse(res).aborted).toBe(true)
  })

  it('does not abort for a response that is already finished', () => {
    // A handler that resolves after `res.end()` must not see the signal fire —
    // `close` has been emitted, and it means the opposite of a disconnect.
    const res = new FakeResponse()
    res.destroyed = true
    res.writableEnded = true

    expect(abortSignalForResponse(res).aborted).toBe(false)
  })
})

describe('abortableDelay', () => {
  it('resolves after the delay', async () => {
    vi.useFakeTimers()
    try {
      const settled = vi.fn()
      void abortableDelay(50).then(settled)

      await vi.advanceTimersByTimeAsync(49)
      expect(settled).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(1)
      expect(settled).toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('resolves rather than rejecting when the signal aborts', async () => {
    // Rejecting would send an ordinary disconnect through the error path and
    // write an `error` frame to a socket that is already gone.
    const controller = new AbortController()
    const pending = abortableDelay(60_000, controller.signal)

    controller.abort()

    await expect(pending).resolves.toBeUndefined()
  })

  it('resolves immediately for a signal that has already aborted', async () => {
    const controller = new AbortController()
    controller.abort()

    await expect(abortableDelay(60_000, controller.signal)).resolves.toBeUndefined()
  })

  it('clears its timer when aborted, so the process is not held open', async () => {
    vi.useFakeTimers()
    try {
      const clear = vi.spyOn(globalThis, 'clearTimeout')
      const controller = new AbortController()
      const pending = abortableDelay(60_000, controller.signal)

      controller.abort()
      await pending

      expect(clear).toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('streamFromIterable', () => {
  it('writes each value as UTF-8', async () => {
    const stream = streamFromIterable(trackedSource(['a', 'é', '🙂']).iterable)

    expect(await readAll(stream)).toBe('aé🙂')
  })

  it('asks the source for one value at a time', async () => {
    // The property that makes this a stream rather than a buffer with a
    // stream's API: a source that has not been read from has not been run.
    const { state, iterable } = trackedSource(['a', 'b', 'c'])
    const reader = streamFromIterable(iterable).getReader()

    await reader.read()
    expect(state.yielded).toBe(1)

    await reader.read()
    expect(state.yielded).toBe(2)

    await reader.cancel()
  })

  it('runs the source’s finally when the consumer cancels', async () => {
    const { state, iterable } = trackedSource(['a', 'b', 'c'])
    const reader = streamFromIterable(iterable).getReader()

    await reader.read()
    await reader.cancel()

    expect(state.returned).toBe(true)
  })

  it('runs the source’s finally when the signal aborts', async () => {
    const controller = new AbortController()
    const { state, iterable } = trackedSource(['a', 'b', 'c'])
    const reader = streamFromIterable(iterable, { signal: controller.signal }).getReader()

    await reader.read()
    controller.abort()
    // The abort listener settles the source asynchronously; reading to the end
    // is what waits for it, and is also the assertion that the stream closed.
    expect(await reader.read()).toEqual({ done: true, value: undefined })
    expect(state.returned).toBe(true)
  })

  it('produces nothing for a signal that aborted before the first read', async () => {
    const controller = new AbortController()
    controller.abort()
    const { state, iterable } = trackedSource(['a', 'b'])

    expect(await readAll(streamFromIterable(iterable, { signal: controller.signal }))).toBe('')
    expect(state.yielded).toBe(0)
  })

  it('writes the onError chunk and closes when the source throws', async () => {
    async function* failing(): AsyncGenerator<string> {
      yield 'a'
      throw new Error('boom')
    }

    const stream = streamFromIterable(failing(), {
      onError: (error) => `[${(error as Error).message}]`,
    })

    expect(await readAll(stream)).toBe('a[boom]')
  })

  it('closes without extra output when onError is not supplied', async () => {
    async function* failing(): AsyncGenerator<string> {
      yield 'a'
      throw new Error('boom')
    }

    expect(await readAll(streamFromIterable(failing()))).toBe('a')
  })

  it('does not reject the stream when the source throws', async () => {
    // The response is already `200`. Erroring the stream truncates the body and
    // says nothing, which is the outcome the `error` frame exists to replace.
    // Written as a hand-rolled iterable rather than a generator because it has
    // to fail before its first value, which a generator cannot express.
    const failing: AsyncIterable<string> = {
      [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(new Error('boom')) }),
    }

    await expect(readAll(streamFromIterable(failing))).resolves.toBe('')
  })
})

describe('encodeFrame', () => {
  it('writes one newline-terminated line per frame', () => {
    expect(encodeFrame({ type: 'end', count: 2, elapsedMs: 7 })).toBe(
      '{"type":"end","count":2,"elapsedMs":7}\n',
    )
  })

  it('keeps a record containing newlines on one line', () => {
    const line = encodeFrame({ type: 'item', index: 0, data: { text: 'a\nb' } })

    expect(line.split('\n')).toHaveLength(2)
    expect(parseNdjson(line)).toEqual([{ type: 'item', index: 0, data: { text: 'a\nb' } }])
  })
})

describe('ndjsonFrames', () => {
  async function* records(): AsyncGenerator<{ id: number }> {
    yield { id: 1 }
    yield { id: 2 }
  }

  it('numbers the items and terminates with an end frame', async () => {
    const text = await readAll(streamFromIterable(ndjsonFrames(records())))
    const frames = parseNdjson<StreamFrame<{ id: number }>>(text)

    expect(frames).toEqual([
      { type: 'item', index: 0, data: { id: 1 } },
      { type: 'item', index: 1, data: { id: 2 } },
      { type: 'end', count: 2, elapsedMs: expect.any(Number) },
    ])
  })

  it('terminates an empty stream with a zero-count end frame', async () => {
    async function* nothing(): AsyncGenerator<never> {}

    const text = await readAll(streamFromIterable(ndjsonFrames(nothing())))

    expect(parseNdjson<StreamFrame<never>>(text)).toEqual([
      { type: 'end', count: 0, elapsedMs: expect.any(Number) },
    ])
  })
})

describe('streamErrorFrame', () => {
  it('reports a fixed message and logs the real error', () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const cause = new Error('connection to db lost')

    const frames = parseNdjson<StreamFrame<never>>(streamErrorFrame(cause))

    expect(frames).toEqual([{ type: 'error', message: expect.any(String) }])
    // The thrown message must not reach the client: after the first byte there
    // is no error handler left to decide what a caller may see.
    expect(JSON.stringify(frames)).not.toContain('connection to db lost')
    expect(logged).toHaveBeenCalledWith(expect.stringContaining('[stream]'), cause)
  })
})

describe('applyStreamHeaders', () => {
  it('sets the content type and the anti-buffering headers', () => {
    applyStreamHeaders(createEvent(), NDJSON_CONTENT_TYPE)

    expect(headers).toEqual({
      'content-type': NDJSON_CONTENT_TYPE,
      ...STREAM_RESPONSE_HEADERS,
    })
  })

  it('forbids storing and transforming the response', () => {
    // A cached stream replays instantly with none of the timing that was the
    // point; a transformed one is re-encoded by a proxy that buffers to do it.
    expect(STREAM_RESPONSE_HEADERS['cache-control']).toContain('no-store')
    expect(STREAM_RESPONSE_HEADERS['cache-control']).toContain('no-transform')
    expect(STREAM_RESPONSE_HEADERS['x-accel-buffering']).toBe('no')
  })
})

describe('sendNdjson', () => {
  async function* records(): AsyncGenerator<{ id: number }> {
    yield { id: 1 }
  }

  it('sends an NDJSON stream with the streaming headers', async () => {
    await sendNdjson(createEvent(), records())

    expect(headers['content-type']).toBe(NDJSON_CONTENT_TYPE)
    expect(sentStreams).toHaveLength(1)
    expect(parseNdjson<StreamFrame<{ id: number }>>(await readAll(sentStreams[0]!))).toEqual([
      { type: 'item', index: 0, data: { id: 1 } },
      { type: 'end', count: 1, elapsedMs: expect.any(Number) },
    ])
  })

  it('reports a mid-stream failure as an error frame, not a truncated body', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})

    async function* failing(): AsyncGenerator<{ id: number }> {
      yield { id: 1 }
      throw new Error('boom')
    }

    await sendNdjson(createEvent(), failing())
    const frames = parseNdjson<StreamFrame<{ id: number }>>(await readAll(sentStreams[0]!))

    expect(frames).toEqual([
      { type: 'item', index: 0, data: { id: 1 } },
      { type: 'error', message: expect.any(String) },
    ])
  })

  it('stops the source when the supplied signal aborts', async () => {
    const controller = new AbortController()
    const state = { returned: false }

    async function* forever(): AsyncGenerator<{ id: number }> {
      try {
        for (let id = 1; ; id++) yield { id }
      } finally {
        state.returned = true
      }
    }

    await sendNdjson(createEvent(), forever(), { signal: controller.signal })
    const reader = sentStreams[0]!.getReader()
    await reader.read()

    controller.abort()
    expect(await reader.read()).toEqual({ done: true, value: undefined })
    expect(state.returned).toBe(true)
  })
})

describe('sendProgressiveHtml', () => {
  it('sends an HTML stream with the streaming headers', async () => {
    async function* chunks(): AsyncGenerator<string> {
      yield '<!doctype html><html><body><main>'
      yield '<p>one</p>'
      yield '</main></body></html>'
    }

    await sendProgressiveHtml(createEvent(), chunks())

    expect(headers['content-type']).toBe(PROGRESSIVE_HTML_CONTENT_TYPE)
    expect(await readAll(sentStreams[0]!)).toContain('<p>one</p>')
  })

  it('closes the document when the source throws', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})

    async function* chunks(): AsyncGenerator<string> {
      yield '<!doctype html><html><body><main>'
      throw new Error('boom')
    }

    await sendProgressiveHtml(createEvent(), chunks())
    const html = await readAll(sentStreams[0]!)

    // An HTML parser renders a truncated document as though it were complete,
    // so the visible message is the only signal the reader gets.
    expect(html).toContain('role="alert"')
    expect(html.trimEnd().endsWith('</html>')).toBe(true)
  })
})

describe('htmlErrorChunk', () => {
  it('logs the error and returns a closed document fragment', () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const chunk = htmlErrorChunk(new Error('upstream 503'))

    expect(chunk).toContain('</html>')
    expect(chunk).not.toContain('upstream 503')
    expect(logged).toHaveBeenCalled()
  })
})

describe('escapeHtml', () => {
  it('escapes every character that can break out of text or an attribute', () => {
    expect(escapeHtml(`<script>alert("x" + 'y' + a & b)</script>`)).toBe(
      '&lt;script&gt;alert(&quot;x&quot; + &#39;y&#39; + a &amp; b)&lt;/script&gt;',
    )
  })

  it('leaves ordinary text alone', () => {
    expect(escapeHtml('Record 3 of 8')).toBe('Record 3 of 8')
  })
})
