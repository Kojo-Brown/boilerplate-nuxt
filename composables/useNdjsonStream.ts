import { onScopeDispose, ref, shallowRef, toValue, triggerRef } from 'vue'
import type { MaybeRefOrGetter, Ref, ShallowRef } from 'vue'

import type { StreamFrame } from '~/types/streaming'
import { createNdjsonParser } from '~/utils/ndjson'

/**
 * Reads an NDJSON endpoint and exposes its records as they arrive.
 *
 * This is the client half of `server/utils/stream.ts`, and it exists because
 * neither of the two obvious ways to fetch does the thing this is for:
 *
 *  - `$fetch` / `useAsyncData` read the whole body before resolving. Against a
 *    streaming route they work perfectly and take exactly as long as the slowest
 *    record, which is the cost the stream was there to avoid.
 *  - `fetch(...).then((r) => r.text())` is the same, one layer down.
 *
 * The body has to be read through `response.body.getReader()`, and then every
 * problem in `utils/ndjson.ts` is yours: chunk boundaries in the middle of a
 * line, chunk boundaries in the middle of a character, and a body that can stop
 * at any point without the status code ever having said so.
 *
 * ```vue
 * const { items, status, error, start, stop } = useNdjsonStream<FeedItem>(url)
 * ```
 *
 * ## Client only
 *
 * `start()` returns immediately on the server. A stream rendered during SSR has
 * to be fully consumed before the HTML can be sent — the render cannot pause —
 * so it would serialise the whole response into the payload and hydrate a client
 * that has nothing left to watch. `useAsyncData` is the right tool for data a
 * page should be server-rendered with; this one is for data that arrives after
 * the page does.
 *
 * ## Progressive rendering
 *
 * `items` is a `shallowRef` over an array that is pushed into and then
 * `triggerRef`'d, rather than a deep `ref` or a new array per record. Vue
 * re-renders the list either way; the difference is that appending to a deep
 * `ref` makes every record reactive on arrival, and reassigning copies the array
 * once per record. Neither is visible at fifty records and both are the reason a
 * five-thousand-record stream renders in steps.
 */
export type NdjsonStreamStatus = 'idle' | 'streaming' | 'done' | 'error' | 'aborted'

export interface UseNdjsonStreamReturn<T> {
  /** Records received so far, in arrival order. */
  readonly items: ShallowRef<T[]>
  readonly status: Ref<NdjsonStreamStatus>
  /** Set when the stream failed, was truncated, or never started. */
  readonly error: Ref<string | null>
  /** How many records the server said it sent, once it has said so. */
  readonly expected: Ref<number | null>
  /** Reads the URL from the start, discarding anything a previous call collected. */
  start: () => Promise<void>
  /** Aborts an in-flight read. Safe to call when nothing is running. */
  stop: () => void
}

export function useNdjsonStream<T>(url: MaybeRefOrGetter<string>): UseNdjsonStreamReturn<T> {
  const items = shallowRef<T[]>([])
  const status = ref<NdjsonStreamStatus>('idle')
  const error = ref<string | null>(null)
  const expected = ref<number | null>(null)

  /**
   * The run that owns the refs. `start()` replaces it, and every write below an
   * `await` is guarded on still being it — otherwise a superseded run, whose
   * pending `read()` rejects a tick after the new one has begun, reports its own
   * abort as the state of the stream that replaced it.
   *
   * It is cleared when a run ends rather than when it is stopped, so `stop()`
   * followed by the rejection it causes is still that run's own outcome.
   */
  let controller: AbortController | null = null

  function stop(): void {
    controller?.abort()
  }

  function reset(): void {
    items.value = []
    triggerRef(items)
    error.value = null
    expected.value = null
  }

  /**
   * Applies one frame. Returns true for a frame that ends the stream, which is
   * what distinguishes a body that finished from a body that stopped.
   */
  function apply(frame: StreamFrame<T>): boolean {
    switch (frame.type) {
      case 'item':
        items.value.push(frame.data)
        triggerRef(items)
        return false
      case 'end':
        expected.value = frame.count
        status.value = 'done'
        return true
      case 'error':
        error.value = frame.message
        status.value = 'error'
        return true
    }
  }

  async function start(): Promise<void> {
    if (import.meta.server) return

    stop()
    reset()
    status.value = 'streaming'

    const request = new AbortController()
    controller = request
    const isCurrent = (): boolean => controller === request

    try {
      const response = await fetch(toValue(url), {
        signal: request.signal,
        headers: { accept: 'application/x-ndjson' },
      })

      if (!response.ok) {
        throw new Error(`Request failed: ${response.status} ${response.statusText}`)
      }
      if (!response.body) {
        // No `body` means the environment buffered the response away — a
        // polyfilled fetch, or a browser too old for streams. Reading
        // `response.text()` here would "work" and silently stop being a stream.
        throw new Error('This browser cannot read a streamed response body.')
      }

      const terminated = await consume(response.body, isCurrent)

      if (!isCurrent()) return
      if (!terminated) {
        // The body ended without an `end` or `error` frame. Everything received
        // is still valid; what is not known is whether there was more.
        error.value = 'The connection closed before the server finished sending.'
        status.value = 'error'
      }
    } catch (cause) {
      if (!isCurrent()) return
      if (request.signal.aborted) {
        status.value = 'aborted'
        return
      }
      error.value = cause instanceof Error ? cause.message : 'The stream could not be read.'
      status.value = 'error'
    } finally {
      if (controller === request) controller = null
    }
  }

  /** Reads the body to its end. Returns whether a terminal frame arrived. */
  async function consume(
    body: ReadableStream<Uint8Array>,
    isCurrent: () => boolean,
  ): Promise<boolean> {
    const reader = body.getReader()
    // `stream: true` keeps a partial multi-byte character until the bytes that
    // complete it arrive, instead of decoding it to U+FFFD.
    const decoder = new TextDecoder()
    const parser = createNdjsonParser<StreamFrame<T>>()

    try {
      for (;;) {
        const { done, value } = await reader.read()

        // Superseded by a later `start()`. Its records must not be mixed into
        // the run that replaced it, and its ending is no longer anyone's news.
        if (!isCurrent()) return true

        if (done) {
          for (const frame of parser.flush()) {
            if (apply(frame)) return true
          }
          return false
        }

        for (const frame of parser.push(decoder.decode(value, { stream: true }))) {
          if (apply(frame)) return true
        }
      }
    } finally {
      // Releasing the lock lets the abort below cancel the underlying stream,
      // and is what the `finally` is for on the early `return true` paths: a
      // terminal frame means the rest of the body will never be read.
      reader.releaseLock()
    }
  }

  // A component that unmounts mid-stream must not leave the request running:
  // its `apply` calls would keep pushing into refs nothing renders, and the
  // server would keep producing for it. `true` suppresses Vue's warning when
  // the composable is called outside a scope, which is the case in tests.
  onScopeDispose(stop, true)

  return { items, status, error, expected, start, stop }
}
