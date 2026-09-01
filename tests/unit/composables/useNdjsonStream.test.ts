import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { effectScope, ref } from 'vue'

import { useNdjsonStream } from '~/composables/useNdjsonStream'
import type { UseNdjsonStreamReturn } from '~/composables/useNdjsonStream'
import type { StreamFrame } from '~/types/streaming'

/**
 * The composable is asserted against a real `ReadableStream` fed one chunk at a
 * time, because everything it is for only exists between the first chunk and the
 * last one: records rendering as they arrive, a failure that arrives as a frame
 * rather than a status, and a body that stops without saying it finished.
 *
 * A mocked `fetch` returning a whole string would make every one of those tests
 * pass without exercising any of them.
 */
interface Row {
  id: number
}

const URL_UNDER_TEST = '/api/streaming/feed'

function line(frame: StreamFrame<Row>): string {
  return `${JSON.stringify(frame)}\n`
}

/** A response body the test writes into, byte by byte if it wants to. */
function createPushableBody(signal?: AbortSignal) {
  const encoder = new TextEncoder()
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined

  const body = new ReadableStream<Uint8Array>({
    start(streamController) {
      controller = streamController
      // A real `fetch` rejects the in-flight read when its signal aborts. The
      // composable's `aborted` status depends on that, so the fake has to do it.
      signal?.addEventListener(
        'abort',
        () => {
          try {
            streamController.error(new DOMException('The operation was aborted.', 'AbortError'))
          } catch {
            // Already closed — the stream finished before the abort arrived.
          }
        },
        { once: true },
      )
    },
  })

  return {
    body,
    push: (text: string) => controller?.enqueue(encoder.encode(text)),
    close: () => controller?.close(),
  }
}

interface FetchCall {
  url: string
  signal: AbortSignal | undefined
  push: (text: string) => void
  close: () => void
}

let calls: FetchCall[]
let response: { ok: boolean; status: number; statusText: string; withBody: boolean }

/** The most recent request, which is the one every test is driving. */
function current(): FetchCall {
  const call = calls.at(-1)
  if (!call) throw new Error('fetch has not been called yet')
  return call
}

/** Lets the composable's pending microtasks and reads settle. */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

beforeEach(() => {
  calls = []
  response = { ok: true, status: 200, statusText: 'OK', withBody: true }

  vi.stubGlobal('fetch', (url: string, init?: { signal?: AbortSignal }) => {
    const pushable = createPushableBody(init?.signal)
    calls.push({ url, signal: init?.signal, push: pushable.push, close: pushable.close })

    return Promise.resolve({
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      body: response.withBody ? pushable.body : null,
    })
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('useNdjsonStream', () => {
  it('starts idle with nothing collected', () => {
    const stream = useNdjsonStream<Row>(URL_UNDER_TEST)

    expect(stream.status.value).toBe('idle')
    expect(stream.items.value).toEqual([])
    expect(stream.error.value).toBeNull()
    expect(stream.expected.value).toBeNull()
  })

  it('exposes each record as it arrives rather than at the end', async () => {
    const stream = useNdjsonStream<Row>(URL_UNDER_TEST)
    const finished = stream.start()
    await tick()

    expect(stream.status.value).toBe('streaming')

    current().push(line({ type: 'item', index: 0, data: { id: 1 } }))
    await tick()
    expect(stream.items.value).toEqual([{ id: 1 }])

    current().push(line({ type: 'item', index: 1, data: { id: 2 } }))
    await tick()
    expect(stream.items.value).toEqual([{ id: 1 }, { id: 2 }])

    current().push(line({ type: 'end', count: 2, elapsedMs: 12 }))
    current().close()
    await finished

    expect(stream.status.value).toBe('done')
    expect(stream.expected.value).toBe(2)
    expect(stream.error.value).toBeNull()
  })

  it('reassembles a record split across chunk boundaries', async () => {
    const stream = useNdjsonStream<Row>(URL_UNDER_TEST)
    const finished = stream.start()
    await tick()

    const document = line({ type: 'item', index: 0, data: { id: 7 } })
    current().push(document.slice(0, 9))
    await tick()
    expect(stream.items.value).toEqual([])

    current().push(document.slice(9))
    await tick()
    expect(stream.items.value).toEqual([{ id: 7 }])

    current().push(line({ type: 'end', count: 1, elapsedMs: 3 }))
    current().close()
    await finished
  })

  it('reads the URL when the stream starts, not when the composable is called', async () => {
    const url = ref(`${URL_UNDER_TEST}?count=1`)
    const stream = useNdjsonStream<Row>(url)

    url.value = `${URL_UNDER_TEST}?count=2`
    const finished = stream.start()
    await tick()

    expect(current().url).toBe(`${URL_UNDER_TEST}?count=2`)

    current().push(line({ type: 'end', count: 0, elapsedMs: 1 }))
    current().close()
    await finished
  })

  it('surfaces an error frame as a failure, keeping the records before it', async () => {
    const stream = useNdjsonStream<Row>(URL_UNDER_TEST)
    const finished = stream.start()
    await tick()

    current().push(line({ type: 'item', index: 0, data: { id: 1 } }))
    current().push(line({ type: 'error', message: 'The stream ended early.' }))
    current().close()
    await finished

    expect(stream.status.value).toBe('error')
    expect(stream.error.value).toBe('The stream ended early.')
    // The response was a 200 and the record that arrived before the failure is
    // still a record. Discarding it would throw away work that succeeded.
    expect(stream.items.value).toEqual([{ id: 1 }])
  })

  it('reports a body that ended without a terminal frame as truncated', async () => {
    // The status line said 200 and the body simply stopped — a proxy timeout, a
    // killed process. Without the `end` frame this is indistinguishable from a
    // complete stream, which is the reason the frame exists.
    const stream = useNdjsonStream<Row>(URL_UNDER_TEST)
    const finished = stream.start()
    await tick()

    current().push(line({ type: 'item', index: 0, data: { id: 1 } }))
    current().close()
    await finished

    expect(stream.status.value).toBe('error')
    expect(stream.error.value).toMatch(/closed before the server finished/)
    expect(stream.items.value).toEqual([{ id: 1 }])
  })

  it('parses a final record that arrived without its newline', async () => {
    const stream = useNdjsonStream<Row>(URL_UNDER_TEST)
    const finished = stream.start()
    await tick()

    current().push(line({ type: 'item', index: 0, data: { id: 1 } }))
    current().push(JSON.stringify({ type: 'end', count: 1, elapsedMs: 4 }))
    current().close()
    await finished

    expect(stream.status.value).toBe('done')
    expect(stream.expected.value).toBe(1)
  })

  it('reports a failed request without reading a body', async () => {
    response = { ok: false, status: 401, statusText: 'Unauthorized', withBody: true }
    const stream = useNdjsonStream<Row>(URL_UNDER_TEST)

    await stream.start()

    expect(stream.status.value).toBe('error')
    expect(stream.error.value).toContain('401')
  })

  it('refuses to fall back to a buffered read when there is no stream body', async () => {
    // `response.text()` would "work" here and stop being a stream, silently.
    response = { ok: true, status: 200, statusText: 'OK', withBody: false }
    const stream = useNdjsonStream<Row>(URL_UNDER_TEST)

    await stream.start()

    expect(stream.status.value).toBe('error')
    expect(stream.error.value).toMatch(/cannot read a streamed response body/)
  })

  it('aborts the request on stop and keeps what it had', async () => {
    const stream = useNdjsonStream<Row>(URL_UNDER_TEST)
    const finished = stream.start()
    await tick()

    current().push(line({ type: 'item', index: 0, data: { id: 1 } }))
    await tick()

    stream.stop()
    await finished

    expect(current().signal?.aborted).toBe(true)
    expect(stream.status.value).toBe('aborted')
    expect(stream.items.value).toEqual([{ id: 1 }])
  })

  it('discards the previous run when started again', async () => {
    const stream = useNdjsonStream<Row>(URL_UNDER_TEST)
    const first = stream.start()
    await tick()
    current().push(line({ type: 'item', index: 0, data: { id: 1 } }))
    await tick()

    const second = stream.start()
    await first
    await tick()

    expect(stream.items.value).toEqual([])
    expect(calls).toHaveLength(2)

    current().push(line({ type: 'end', count: 0, elapsedMs: 1 }))
    current().close()
    await second

    expect(stream.status.value).toBe('done')
  })

  it('aborts the request when its effect scope is disposed', async () => {
    // A component unmounted mid-stream leaves the server producing for a client
    // that no longer exists, and `apply` pushing into refs nothing renders.
    const scope = effectScope()
    let stream: UseNdjsonStreamReturn<Row> | undefined
    scope.run(() => {
      stream = useNdjsonStream<Row>(URL_UNDER_TEST)
    })

    const finished = stream?.start()
    await tick()

    scope.stop()
    await finished

    expect(current().signal?.aborted).toBe(true)
  })

  it('is safe to stop when nothing is running', () => {
    const stream = useNdjsonStream<Row>(URL_UNDER_TEST)

    expect(() => stream.stop()).not.toThrow()
    expect(calls).toHaveLength(0)
  })
})
