import type { H3Event } from 'h3'

import {
  applyStreamHeaders,
  requestAbortSignal,
  streamFromIterable,
  type SendStreamOptions,
} from '~/server/utils/stream'
import {
  SSE_DONE_EVENT,
  SSE_ERROR_EVENT,
  type SseDonePayload,
  type SseErrorPayload,
  type SseFields,
  type SseMessage,
} from '~/types/sse'

/**
 * Server-Sent Events: the framing, the heartbeat, and the disconnect cleanup.
 *
 * The transport underneath is the one `server/utils/stream.ts` already built —
 * a pull-driven `ReadableStream` handed to `sendStream`, cancelled by
 * {@link requestAbortSignal} when the client goes away. What SSE adds on top of
 * a generic byte stream is a wire format with rules that are easy to satisfy by
 * accident and hard to notice breaking, plus one requirement no other stream in
 * this codebase has: **the connection has to prove it is alive while nothing is
 * happening on it.**
 *
 * ## Why a heartbeat is not optional
 *
 * An idle SSE connection is indistinguishable from a dead one. Every layer
 * between the handler and the browser — an ALB with a 60-second idle timeout,
 * nginx's `proxy_read_timeout`, a corporate proxy, a phone's NAT table — is
 * counting the seconds since the last byte, and closes the socket when its own
 * number is reached. Neither end is told. The server's `res` emits `close`, the
 * client's `EventSource` fires `error` and reconnects, and the visible symptom
 * is a stream that works locally and silently restarts every minute in
 * production, once per hop, on whichever layer has the smallest timeout.
 *
 * {@link withHeartbeat} is the fix: an SSE comment (`: ping`) written whenever
 * the source has been quiet for `intervalMs`. It is a comment rather than an
 * event because the specification tells the parser to discard those lines
 * outright — so the keepalive costs the client nothing, does not reach
 * `onmessage`, does not advance `lastEventId`, and cannot be mistaken for data.
 *
 * The interval is a maximum idle gap, not a period: a message resets it. A
 * heartbeat sent 10ms after a real message proves nothing that the message did
 * not already prove.
 *
 * ## What is actually hard about it
 *
 * The heartbeat has to be emitted *while the source is still being awaited*, and
 * an async generator suspended in `await iterator.next()` cannot yield. So this
 * is a race, and the trap is that a naive race calls `next()` again on the next
 * tick — which for an async generator queues a second request against the same
 * source. That silently drops the value the first call is about to produce, or
 * advances a database cursor twice per delivered row. {@link withHeartbeat}
 * holds the one pending `next()` across every heartbeat until it settles, which
 * is the whole reason it is a hand-written loop instead of four lines.
 *
 * ## Disconnect cleanup
 *
 * Three things have to unwind when the browser navigates away, and each has its
 * own hook:
 *
 *  1. The response stream ends — `streamFromIterable` aborts on the signal.
 *  2. The heartbeat timer is cleared — {@link withHeartbeat}'s `finally`, via a
 *     cancellable timer rather than `abortableDelay`. A timer per message with
 *     no way to cancel it leaves one abort listener per message attached to the
 *     signal, which on a long stream is both a leak and a
 *     `MaxListenersExceededWarning`.
 *  3. The application source's `finally` runs — the generator's `return()`,
 *     propagated down the chain from `streamFromIterable` through
 *     `withHeartbeat` to the caller's generator. That is where a cursor gets
 *     closed or a subscription dropped.
 *
 * Without (3) a disconnected client still costs a database cursor for as long as
 * the stream would have run, which is the failure this whole file is shaped to
 * avoid.
 */

/** `content-type` for a Server-Sent Events body. */
export const SSE_CONTENT_TYPE = 'text/event-stream; charset=utf-8'

/**
 * Default maximum idle gap before a keepalive comment.
 *
 * 15 seconds is chosen to sit under the smallest idle timeout a stream is
 * likely to meet — AWS ALB defaults to 60s, nginx's `proxy_read_timeout` to
 * 60s, Cloudflare to 100s — with enough margin that one dropped packet does not
 * reach the limit.
 */
export const DEFAULT_HEARTBEAT_MS = 15_000

/**
 * Default reconnection delay handed to the client, in milliseconds.
 *
 * `EventSource` reconnects on its own with an implementation-defined delay
 * (Chrome uses 3s) unless the stream says otherwise. Setting it explicitly is
 * what makes the reconnect behaviour a property of the endpoint rather than of
 * whichever browser is reading it.
 */
export const DEFAULT_RETRY_MS = 3_000

/** The keepalive comment body. Anything after `:` is discarded by the client. */
export const HEARTBEAT_COMMENT = 'ping'

/**
 * Characters that cannot appear in a single-line SSE field value.
 *
 * `\r` and `\n` end a field line, so one inside an `id` or an `event` name lets
 * that value inject arbitrary fields — including a `data:` line — into the
 * stream. It is header injection with a different delimiter, and the values most
 * likely to carry it (an `id` built from a database key, an event name built
 * from a resource type) are the ones most likely to be caller-influenced. NUL is
 * here because the specification says an `id` field containing one is ignored
 * altogether, which breaks resumption in a way nothing reports.
 */
const UNSAFE_FIELD_VALUE = /[\r\n\0]/

/** Splits on every line terminator SSE recognises, not just `\n`. */
const LINE_TERMINATORS = /\r\n|\r|\n/

/**
 * Encodes one SSE block — the `field: value` lines plus the blank line that
 * dispatches them.
 *
 * Multi-line `data` becomes one `data:` line per line, which the client rejoins
 * with `\n`. That is the only field with a defined multi-line form, and it is
 * why `data` is safe to hand arbitrary text while `event` and `id` throw on one.
 *
 * A block with no fields encodes to the empty string rather than a bare blank
 * line: dispatching nothing is better spelled as writing nothing.
 */
export function encodeSseBlock(fields: SseFields): string {
  const lines: string[] = []

  if (fields.event !== undefined) {
    assertSingleLine('event', fields.event)
    lines.push(`event: ${fields.event}`)
  }

  if (fields.id !== undefined) {
    assertSingleLine('id', fields.id)
    lines.push(`id: ${fields.id}`)
  }

  if (fields.retryMs !== undefined) {
    if (!Number.isInteger(fields.retryMs) || fields.retryMs < 0) {
      // The client parses this field as ASCII digits and ignores it otherwise,
      // so `retry: 3000.5` is not a rounded delay, it is no delay at all.
      throw new TypeError(`SSE retry must be a non-negative integer, received ${fields.retryMs}`)
    }
    lines.push(`retry: ${fields.retryMs}`)
  }

  if (fields.data !== undefined) {
    for (const line of fields.data.split(LINE_TERMINATORS)) {
      // `data:` rather than `data: ` for an empty line. The client strips one
      // leading space, so both decode to the empty string; this one does not
      // put trailing whitespace on the wire for an intermediary to trim.
      lines.push(line === '' ? 'data:' : `data: ${line}`)
    }
  }

  if (lines.length === 0) return ''

  return `${lines.join('\n')}\n\n`
}

/**
 * Encodes an SSE comment: a line the client is required to ignore.
 *
 * Used for the heartbeat, and for anything else that should keep the connection
 * warm without being data.
 */
export function encodeSseComment(text: string): string {
  // Every line of a multi-line comment needs its own `:`, or the second line is
  // parsed as a field.
  return `${text
    .split(LINE_TERMINATORS)
    .map((line) => `: ${line}`)
    .join('\n')}\n\n`
}

function assertSingleLine(field: 'event' | 'id', value: string): void {
  if (!UNSAFE_FIELD_VALUE.test(value)) return
  throw new TypeError(
    `SSE ${field} must not contain a line terminator or NUL; received ${JSON.stringify(value)}`,
  )
}

/** A `setTimeout` that can be called off without waiting for it. */
interface CancellableDelay {
  /** Resolves when the delay elapses or `signal` aborts. Never rejects. */
  readonly promise: Promise<void>
  /** Clears the timer and detaches the abort listener. The promise never settles. */
  cancel: () => void
}

/**
 * The timer {@link withHeartbeat} races against.
 *
 * `abortableDelay` in `server/utils/stream.ts` is the same idea without the
 * `cancel`, and that difference matters here: this timer is created once per
 * message rather than once per request, so a delay that can only be ended by
 * elapsing leaves a live timer and an attached `abort` listener behind for every
 * message a busy stream delivers.
 */
function cancellableDelay(ms: number, signal?: AbortSignal): CancellableDelay {
  if (signal?.aborted) return { promise: Promise.resolve(), cancel: () => {} }

  let cancel = (): void => {}

  const promise = new Promise<void>((resolve) => {
    const settle = (): void => {
      signal?.removeEventListener('abort', settle)
      clearTimeout(timer)
      resolve()
    }

    const timer = setTimeout(settle, ms)
    signal?.addEventListener('abort', settle, { once: true })

    cancel = (): void => {
      signal?.removeEventListener('abort', settle)
      clearTimeout(timer)
    }
  })

  return { promise, cancel }
}

/** Which half of the race in {@link withHeartbeat} settled first. */
type HeartbeatRace =
  { readonly kind: 'value'; readonly result: IteratorResult<string> } | { readonly kind: 'tick' }

/** Options for {@link withHeartbeat}. */
export interface HeartbeatOptions {
  /** Maximum idle gap before a beat, in milliseconds. `0` disables the heartbeat. */
  readonly intervalMs: number
  /** Ends the stream, and the source with it, when the client disconnects. */
  readonly signal?: AbortSignal
  /** Produces the idle chunk. Defaults to a `: ping` comment. */
  readonly beat?: () => string
}

/**
 * Passes `source` through, emitting `beat()` whenever it has been quiet for
 * `intervalMs`.
 *
 * The source is entered exactly once per delivered chunk no matter how many
 * beats pass in between — see the note about a second `next()` in this module's
 * header — and its `return()` is called once, on every exit path, so a
 * generator's `finally` runs on disconnect as well as on completion.
 */
export async function* withHeartbeat(
  source: AsyncIterable<string>,
  options: HeartbeatOptions,
): AsyncGenerator<string> {
  const { intervalMs, signal, beat = defaultBeat } = options

  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    // No heartbeat wanted. `yield*` delegates `return()` to the source, so the
    // cleanup contract above still holds on this path.
    yield* source
    return
  }

  const iterator = source[Symbol.asyncIterator]()
  /**
   * The in-flight `next()`. Kept across heartbeats: an async generator queues
   * concurrent `next()` calls, so asking again on a tick would consume a value
   * this loop never yields.
   */
  let pending: Promise<IteratorResult<string>> | undefined

  try {
    while (signal === undefined || !signal.aborted) {
      pending ??= iterator.next()

      const timer = cancellableDelay(intervalMs, signal)
      let settled: HeartbeatRace
      try {
        settled = await Promise.race<HeartbeatRace>([
          pending.then((result) => ({ kind: 'value', result }) as const),
          timer.promise.then(() => ({ kind: 'tick' }) as const),
        ])
      } finally {
        // Before any `yield`, so the timer is never alive while this generator
        // is suspended waiting for the consumer to ask for more.
        timer.cancel()
      }

      if (settled.kind === 'tick') {
        // `cancellableDelay` resolves on abort as well as on elapse, so a tick
        // is also how a disconnect arrives while the source is blocked.
        if (signal?.aborted) return
        yield beat()
        continue
      }

      pending = undefined
      if (settled.result.done) return
      yield settled.result.value
    }
  } finally {
    // The one place the source is told, covering completion, disconnect, a
    // throw from the source, and the consumer cancelling the response.
    await iterator.return?.()
  }
}

function defaultBeat(): string {
  return encodeSseComment(HEARTBEAT_COMMENT)
}

/**
 * The `Last-Event-ID` a reconnecting `EventSource` sent, or `null` for a fresh
 * connection.
 *
 * The browser sends this by itself, with the `id` of the last block it
 * dispatched, on every automatic reconnect — which is what makes SSE resumable
 * without any client code. A handler that ignores it is not broken so much as
 * silently lossy: the reconnect succeeds, the client sees a stream, and the
 * messages produced during the gap are simply never delivered.
 *
 * The query fallback is for callers that cannot set the header. `EventSource`
 * has no options for request headers at all, so a client that wants to resume
 * from a stored position rather than from where this browser tab left off has
 * no other way to say so.
 */
export function resumeFrom(event: H3Event): string | null {
  return (
    parseResumeToken(getRequestHeader(event, 'last-event-id')) ??
    parseResumeToken(getQuery(event)['lastEventId'])
  )
}

/**
 * Validates a resume token: present, a string, non-empty, and bounded.
 *
 * Bounded because this is caller-supplied input that a handler will turn into a
 * cursor or a sequence number. It is exported so the rules can be asserted
 * without an `H3Event` — the same reason `readFeedQuery` is exported from
 * `server/api/streaming/feed.get.ts`.
 */
export const MAX_RESUME_TOKEN_LENGTH = 256

export function parseResumeToken(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const token = raw.trim()
  if (token === '' || token.length > MAX_RESUME_TOKEN_LENGTH) return null
  // A token that reaches an `id:` line again must not be able to break framing.
  // Rejecting is correct rather than sanitising: a mangled resume point would
  // restart the stream somewhere neither end agreed on.
  if (UNSAFE_FIELD_VALUE.test(token)) return null
  return token
}

/** Options for {@link sendSse}. */
export interface SendSseOptions extends SendStreamOptions {
  /** Maximum idle gap before a keepalive. Defaults to {@link DEFAULT_HEARTBEAT_MS}. */
  readonly heartbeatMs?: number
  /** Reconnection delay sent to the client. Defaults to {@link DEFAULT_RETRY_MS}. */
  readonly retryMs?: number
}

/**
 * Streams `messages` to the client as Server-Sent Events.
 *
 * ```ts
 * export default defineEventHandler((event) => {
 *   const signal = requestAbortSignal(event)
 *   return sendSse(event, ticks(resumeFrom(event), signal), { signal })
 * })
 * ```
 *
 * The response opens with a `retry` block, carries one block per message, and
 * ends with a {@link SSE_DONE_EVENT} block saying the stream finished on
 * purpose — without which a client that reaches the end of the body simply
 * reconnects. A source that throws after the first byte ends with an
 * {@link SSE_ERROR_EVENT} block instead.
 */
export function sendSse<T>(
  event: H3Event,
  messages: AsyncIterable<SseMessage<T>>,
  options: SendSseOptions = {},
): Promise<void> {
  const signal = options.signal ?? requestAbortSignal(event)
  applyStreamHeaders(event, SSE_CONTENT_TYPE)

  const blocks = withHeartbeat(sseBlocks(messages, options.retryMs ?? DEFAULT_RETRY_MS), {
    intervalMs: options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS,
    signal,
  })

  return sendStream(event, streamFromIterable(blocks, { signal, onError: sseErrorBlock }))
}

/**
 * Encodes a message stream as SSE blocks, bracketed by the `retry` the
 * connection opens with and the `done` event it closes on.
 */
export async function* sseBlocks<T>(
  messages: AsyncIterable<SseMessage<T>>,
  retryMs: number,
): AsyncGenerator<string> {
  const startedAt = Date.now()
  let count = 0

  yield encodeSseBlock({ retryMs })

  for await (const message of messages) {
    yield encodeSseBlock({
      // Spread rather than read field by field: `exactOptionalPropertyTypes`
      // distinguishes an absent optional property from one set to `undefined`,
      // and only the spread keeps `event`, `id` and `retryMs` absent when the
      // message did not carry them.
      ...message,
      // `JSON.stringify(undefined)` is `undefined`, not a string, which would
      // encode a block with no `data:` line at all — dispatching nothing while
      // looking like a delivered message. `null` is what JSON means by it.
      data: JSON.stringify(message.data) ?? 'null',
    })
    count++
  }

  const done: SseDonePayload = { count, elapsedMs: Date.now() - startedAt }
  yield encodeSseBlock({ event: SSE_DONE_EVENT, data: JSON.stringify(done) })
}

/**
 * The block for a source that threw mid-response.
 *
 * The message is a constant rather than the thrown error's, for the reason
 * `streamErrorFrame` gives in `server/utils/stream.ts`: a handler that fails
 * before the first byte gets Nitro's error handling, which decides what a client
 * may see, and a handler that fails after it has no such layer.
 */
export function sseErrorBlock(error: unknown): string {
  console.error('[sse] source failed after the response had started:', error)
  const payload: SseErrorPayload = {
    message: 'The stream ended early. It will not resume on its own.',
  }
  return encodeSseBlock({ event: SSE_ERROR_EVENT, data: JSON.stringify(payload) })
}
