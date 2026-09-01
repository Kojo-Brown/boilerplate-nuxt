import type { H3Event } from 'h3'

import type { StreamFrame } from '~/types/streaming'

/**
 * Streaming responses: `sendStream`, and the four things it does not do for you.
 *
 * `sendStream(event, stream)` is a thin adapter. It takes a `ReadableStream` (or
 * a Node `Readable`), pipes it into `event.node.res`, and ends the response when
 * the source ends. That is genuinely all of it — which is fine, and is also why
 * a route that reaches for it directly tends to be wrong in the same four ways:
 *
 *  1. **It never stops.** `sendStream` does not watch the request. When the
 *     browser navigates away mid-stream, the source keeps producing and the
 *     writes land on a dead socket. A generator reading a database cursor holds
 *     that cursor until it finishes a response nobody is receiving.
 *     {@link requestAbortSignal} is the signal that says the client is gone, and
 *     {@link streamFromIterable} calls the source's `return()` when it fires, so
 *     a generator's `finally` runs.
 *
 *  2. **Errors have nowhere to go.** The status line left with the first chunk.
 *     Throwing from the source truncates the body and tells the client nothing;
 *     an `error` frame tells it exactly what happened. See `types/streaming.ts`.
 *
 *  3. **Nothing else knows the response is a stream.** A reverse proxy that
 *     buffers, a CDN that caches, a compressor that waits for more input — each
 *     of them turns a stream back into a single late response, and none of them
 *     is a bug you can see locally. {@link STREAM_RESPONSE_HEADERS} is the set
 *     that opts out of all three.
 *
 *  4. **An eager source is not a stream.** Building the whole payload and
 *     wrapping it in a `ReadableStream` streams nothing; it just delays it. The
 *     stream {@link streamFromIterable} builds is pull-driven — it asks the
 *     source for the next value only when the consumer has taken the last one.
 *
 * ## What `sendStream` will not honour: backpressure
 *
 * h3 1.x pipes a web `ReadableStream` into a `WritableStream` whose `write()`
 * calls `res.write(chunk)` and returns immediately, without waiting for the
 * `drain` that `res.write()` returning `false` asks for. So a source faster than
 * the socket buffers in the Node response rather than being slowed down by it,
 * and the pull-driven design above does not, on this path, reach all the way to
 * the network.
 *
 * That is worth stating rather than implying, because the alternative would be
 * to stop using `sendStream` — the fix is a `Readable.fromWeb(stream).pipe(res)`,
 * which does honour it. It is left as it is for two reasons: the item this code
 * exists for is `sendStream`, and every consumer here (`fetch`, a test reading
 * the stream directly, `new Response(stream)`) applies the pull semantics
 * correctly, so the property is real everywhere except the last hop. Sources
 * that can outrun a socket by enough to matter should page — see the `count`
 * clamp in `server/api/streaming/feed.get.ts`.
 */

/** Abort reason for a response whose client went away before it finished. */
export const CLIENT_DISCONNECTED = 'client disconnected'

/** `content-type` for newline-delimited JSON. */
export const NDJSON_CONTENT_TYPE = 'application/x-ndjson; charset=utf-8'

/** `content-type` for a progressively flushed HTML document. */
export const PROGRESSIVE_HTML_CONTENT_TYPE = 'text/html; charset=utf-8'

/**
 * The headers that keep a streamed response streamed, applied by
 * {@link applyStreamHeaders} to every route in this module.
 *
 *  - `cache-control: no-store` — a cached stream is a contradiction: the entry
 *    would be the concatenated body, replayed instantly, with none of the timing
 *    that was the point. `no-transform` additionally forbids an intermediary
 *    from re-encoding the body, which is how a compressing proxy ends up
 *    buffering it.
 *  - `x-accel-buffering: no` — nginx buffers proxied responses by default and
 *    will hold a whole stream to deliver it as one response. This is the header
 *    it reads to stop. It is a no-op behind anything else, which is the right
 *    trade for a header that is invisible until it is deployed behind nginx and
 *    inexplicable once it is.
 */
export const STREAM_RESPONSE_HEADERS = Object.freeze({
  'cache-control': 'no-store, no-transform',
  'x-accel-buffering': 'no',
})

/** Options shared by the `send*` helpers below. */
export interface SendStreamOptions {
  /**
   * Cancels the source when the client goes away. Defaults to
   * {@link requestAbortSignal} for this event; pass one explicitly when the
   * source needs the same signal (an abortable sleep, a `fetch` upstream).
   */
  readonly signal?: AbortSignal
}

/**
 * The part of a Node `ServerResponse` {@link abortSignalForResponse} touches.
 *
 * Named as a structural type so the disconnect logic can be tested against a
 * three-property fake instead of a live socket — that logic is a pair of
 * conditions on `writableEnded`, and both of them are wrong in ways an
 * end-to-end test would not reliably catch.
 */
export interface ClosableResponse {
  readonly writableEnded: boolean
  readonly destroyed: boolean
  once(eventName: 'close', listener: () => void): unknown
}

/**
 * An `AbortSignal` that fires when the client disconnects before the response
 * has finished.
 *
 * The signal to watch is `res`, not `req`. `req` emits `close` as soon as the
 * *request* is done being read, which for a `GET` is immediately — a signal
 * derived from it aborts every stream before it sends anything. `res` emits
 * `close` once, either way, and `writableEnded` is what separates the two
 * cases: true when we ended the response ourselves, false when the connection
 * went away underneath it.
 */
export function abortSignalForResponse(res: ClosableResponse): AbortSignal {
  const controller = new AbortController()

  if (res.destroyed && !res.writableEnded) {
    controller.abort(new Error(CLIENT_DISCONNECTED))
    return controller.signal
  }

  res.once('close', () => {
    if (res.writableEnded) return
    controller.abort(new Error(CLIENT_DISCONNECTED))
  })

  return controller.signal
}

/** {@link abortSignalForResponse} for the response of an `H3Event`. */
export function requestAbortSignal(event: H3Event): AbortSignal {
  return abortSignalForResponse(event.node.res)
}

/**
 * `setTimeout` that gives up when `signal` aborts.
 *
 * It **resolves** on abort rather than rejecting. A disconnect is not an error
 * in the source — it is the ordinary end of a request — and rejecting would send
 * it through the `catch` that emits an `error` frame, onto a socket that is
 * already gone. Resolving hands control back to the loop, which checks
 * `signal.aborted`, returns, and lets its `finally` run.
 */
export function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0 || signal?.aborted) return Promise.resolve()

  return new Promise<void>((resolve) => {
    // `finish` closes over `timer`, which is declared below it — safe because it
    // is only ever called from the timer or the abort listener, both of which
    // are registered after the binding is initialised.
    const finish = (): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', finish)
      resolve()
    }

    const timer = setTimeout(finish, ms)
    signal?.addEventListener('abort', finish, { once: true })
  })
}

/** Options for {@link streamFromIterable}. */
export interface StreamFromIterableOptions {
  /** Ends the stream and calls the source's `return()` when it aborts. */
  readonly signal?: AbortSignal
  /**
   * Maps a throw from the source to one last chunk of body, or `undefined` to
   * end the response with nothing extra. See {@link streamErrorFrame}.
   */
  readonly onError?: (error: unknown) => string | undefined
}

/**
 * A UTF-8 `ReadableStream` over an async iterable of already-encoded chunks.
 *
 * Pull-driven on purpose: `pull` asks the iterator for exactly one value each
 * time the consumer's queue has room, so a source that takes a second per record
 * is entered once per second rather than being drained into memory up front.
 * Writing the same loop in `start()` — the shape that reads more naturally —
 * gives you a buffer with a stream's API.
 *
 * On abort, cancel, or a throw from the source, the iterator's `return()` is
 * called exactly once, which is what runs a generator's `finally`. That is the
 * only hook a source has for releasing what it opened.
 */
export function streamFromIterable(
  source: AsyncIterable<string>,
  options: StreamFromIterableOptions = {},
): ReadableStream<Uint8Array> {
  const { signal, onError } = options
  const encoder = new TextEncoder()
  const iterator = source[Symbol.asyncIterator]()

  let controller: ReadableStreamDefaultController<Uint8Array> | undefined
  let settled = false

  function detach(): void {
    signal?.removeEventListener('abort', onAbort)
  }

  /** Ends the source once, and the stream with it. */
  async function settle(closeStream: boolean): Promise<void> {
    if (settled) return
    settled = true
    detach()
    await iterator.return?.()
    if (!closeStream) return
    try {
      controller?.close()
    } catch {
      // The consumer cancelled between the check and the call. Nothing is
      // listening either way, and `close()` on a cancelled stream throws.
    }
  }

  function onAbort(): void {
    void settle(true)
  }

  return new ReadableStream<Uint8Array>({
    start(streamController) {
      controller = streamController
      if (!signal) return
      if (signal.aborted) {
        void settle(true)
        return
      }
      signal.addEventListener('abort', onAbort, { once: true })
    },

    async pull(streamController) {
      if (settled) return

      let next: IteratorResult<string>
      try {
        next = await iterator.next()
      } catch (error) {
        // The source is already finished — a generator that threw cannot be
        // resumed — so the only thing left is to say so in the body.
        const chunk = onError?.(error)
        if (chunk !== undefined && !settled) streamController.enqueue(encoder.encode(chunk))
        await settle(true)
        return
      }

      // The signal can have fired while `next()` was pending. Enqueuing here
      // would push a chunk into a stream that is already closing.
      if (settled) return

      if (next.done) {
        await settle(true)
        return
      }

      streamController.enqueue(encoder.encode(next.value))
    },

    async cancel() {
      // The consumer is closing the stream itself, so `close()` must not be
      // called — but the source still has to be told.
      await settle(false)
    },
  })
}

/** One NDJSON line: a frame, serialised, newline-terminated. */
export function encodeFrame<T>(frame: StreamFrame<T>): string {
  // `JSON.stringify` escapes the newlines inside string values, so a record can
  // never break the line-per-frame framing this depends on.
  return `${JSON.stringify(frame)}\n`
}

/**
 * Wraps a stream of records in {@link encodeFrame}d `item` frames and terminates
 * them with an `end` frame.
 */
export async function* ndjsonFrames<T>(items: AsyncIterable<T>): AsyncGenerator<string> {
  const startedAt = Date.now()
  let count = 0

  for await (const data of items) {
    yield encodeFrame({ type: 'item', index: count, data })
    count++
  }

  yield encodeFrame({ type: 'end', count, elapsedMs: Date.now() - startedAt })
}

/**
 * The `error` frame for a source that threw mid-response.
 *
 * The message is a constant, not the thrown error's. A handler that fails before
 * the first byte gets `AllExceptionsFilter`-style treatment from Nitro, which
 * decides what a client may see; a handler that fails *after* it has no such
 * layer, and copying `error.message` into the body would route around the one
 * that exists. The real error goes to the server log, where it belongs.
 */
export function streamErrorFrame(error: unknown): string {
  console.error('[stream] source failed after the response had started:', error)
  return encodeFrame({ type: 'error', message: 'The stream ended early. Retry the request.' })
}

/** Applies {@link STREAM_RESPONSE_HEADERS} plus a content type. */
export function applyStreamHeaders(event: H3Event, contentType: string): void {
  setResponseHeader(event, 'content-type', contentType)
  for (const [name, value] of Object.entries(STREAM_RESPONSE_HEADERS)) {
    setResponseHeader(event, name, value)
  }
}

/**
 * Streams `items` as NDJSON, one frame per line.
 *
 * ```ts
 * export default defineEventHandler((event) => {
 *   const signal = requestAbortSignal(event)
 *   return sendNdjson(event, rows(signal), { signal })
 * })
 * ```
 */
export function sendNdjson<T>(
  event: H3Event,
  items: AsyncIterable<T>,
  options: SendStreamOptions = {},
): Promise<void> {
  const signal = options.signal ?? requestAbortSignal(event)
  applyStreamHeaders(event, NDJSON_CONTENT_TYPE)

  return sendStream(
    event,
    streamFromIterable(ndjsonFrames(items), { signal, onError: streamErrorFrame }),
  )
}

/** Options for {@link sendProgressiveHtml}. */
export interface SendProgressiveHtmlOptions extends SendStreamOptions {
  /** Last chunk to write when the source throws. Defaults to {@link htmlErrorChunk}. */
  readonly onError?: (error: unknown) => string | undefined
}

/**
 * Streams an HTML document in the order its parts become available.
 *
 * The caller yields strings; whatever it yields first is what the browser gets
 * to paint while the rest is still being produced. There is no framing here
 * because HTML is its own: an unclosed `<body>` is a document the parser is
 * still working on, which is exactly the state a progressive response wants it
 * in.
 */
export function sendProgressiveHtml(
  event: H3Event,
  chunks: AsyncIterable<string>,
  options: SendProgressiveHtmlOptions = {},
): Promise<void> {
  const signal = options.signal ?? requestAbortSignal(event)
  const onError = options.onError ?? htmlErrorChunk
  applyStreamHeaders(event, PROGRESSIVE_HTML_CONTENT_TYPE)

  return sendStream(event, streamFromIterable(chunks, { signal, onError }))
}

/**
 * The HTML counterpart of {@link streamErrorFrame}: says the document is
 * incomplete, then closes the tags the source never got to.
 *
 * Closing them matters. A truncated document is one an error-recovering parser
 * renders as though nothing had gone wrong, so the visible message is the whole
 * signal the reader gets.
 */
export function htmlErrorChunk(error: unknown): string {
  console.error('[stream] HTML source failed after the response had started:', error)
  return '<p role="alert" class="stream-error">This page stopped loading before it was finished.</p>\n</main></body></html>\n'
}

const HTML_ESCAPES: Readonly<Record<string, string>> = Object.freeze({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
})

/**
 * Escapes text for interpolation into a streamed HTML chunk.
 *
 * A streamed document is assembled by string concatenation, without the
 * template compiler that would otherwise be doing this — so it is the one place
 * in a Nuxt app where forgetting is an injection rather than a display bug.
 */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => HTML_ESCAPES[character] ?? character)
}
