/**
 * The Server-Sent Events wire protocol, as this codebase produces it.
 *
 * SSE is a framing over a `text/event-stream` body, specified as part of HTML
 * (WHATWG HTML §9.2). A stream is a sequence of *blocks* separated by blank
 * lines; each block is a set of `field: value` lines, and the blank line is what
 * dispatches it as an event. Four field names are defined and everything else is
 * ignored:
 *
 * ```text
 * retry: 3000
 *
 * : keep-alive
 *
 * event: tick
 * id: 7
 * data: {"seq":7}
 *
 * ```
 *
 * The differences from the NDJSON protocol in `types/streaming.ts` are what make
 * this worth a second transport rather than a second encoding of the first one:
 *
 *  - **The client is built in.** `EventSource` parses this, reconnects on its
 *    own, and replays its position through a `Last-Event-ID` request header.
 *    NDJSON needs `utils/ndjson.ts` and `composables/useNdjsonStream.ts` to do
 *    any of that, and the reconnect is still the caller's problem.
 *  - **Reconnection is part of the protocol.** `retry` sets the client's delay
 *    and `id` sets its resume point, so a dropped connection is a gap the server
 *    can close rather than a stream that starts over. See `resumeFrom` in
 *    `server/utils/sse.ts`.
 *  - **There is no end-of-stream frame.** A server that closes the body is
 *    telling `EventSource` to reconnect, not that the data is finished. Saying
 *    "there is no more" takes an application-level event — {@link SSE_DONE_EVENT}
 *    below — and a client that stops listening when it sees one.
 *
 * What SSE does not carry: a request body, headers per message, binary data, or
 * anything other than `GET` (`EventSource` is `GET`-only). A stream that needs
 * any of those wants the WebSocket item that follows this one in `SPEC.md`.
 */

/**
 * The fields of one SSE block. All optional: a block with only `retry` sets the
 * reconnection delay and dispatches nothing, and a block with only `data`
 * dispatches as the default `message` event.
 */
export interface SseFields {
  /**
   * The event name. Anything other than `message` has to be read with
   * `addEventListener(name, …)` — `onmessage` never sees it, which is the
   * single most common way a working SSE endpoint looks broken from the client.
   */
  readonly event?: string
  /** The payload. Newlines inside it become multiple `data:` lines. */
  readonly data?: string
  /**
   * Sets the client's `lastEventId`, which it sends back as `Last-Event-ID` on
   * its next connection. Emitting one makes the stream resumable; omitting it
   * makes every reconnect a restart.
   */
  readonly id?: string
  /** Reconnection delay in whole milliseconds. Persists for the connection. */
  readonly retryMs?: number
}

/**
 * One application-level message: {@link SseFields} with `data` as a value to be
 * JSON-encoded rather than a string that is already text.
 *
 * `sendSse` serialises `data` with `JSON.stringify`, so a client reads every
 * message with `JSON.parse(ev.data)` and never has to know which messages
 * happen to be strings.
 */
export interface SseMessage<T = unknown> extends Omit<SseFields, 'data'> {
  readonly data: T
}

/**
 * The event name this codebase uses to say a stream is finished on purpose.
 *
 * It exists because SSE has no way to say it. `EventSource` treats a closed body
 * as a connection to re-open after `retry` milliseconds, so a server that just
 * ends the response has started a reconnect loop, not finished a stream. The
 * only way out is for the client to call `close()`, and the only reason it has
 * to is a message telling it to.
 */
export const SSE_DONE_EVENT = 'done'

/** The payload of an {@link SSE_DONE_EVENT} message. */
export interface SseDonePayload {
  /** How many data messages preceded it on this connection. */
  readonly count: number
  /** Wall-clock milliseconds this connection was open. */
  readonly elapsedMs: number
}

/**
 * The event name for a source that failed after the response had started.
 *
 * The same problem `StreamErrorFrame` solves in `types/streaming.ts`: the status
 * code left with the first byte, so a failure on message 900 cannot become a
 * 500. Unlike the NDJSON case it is not the client's only signal — `EventSource`
 * fires `error` on any disconnect — but that event says "the connection
 * dropped", which is also what a proxy timeout and a laptop lid look like. This
 * one says the server stopped on purpose and will not have more.
 */
export const SSE_ERROR_EVENT = 'stream-error'

/** The payload of an {@link SSE_ERROR_EVENT} message. */
export interface SseErrorPayload {
  /** Written for the client, never copied from the thrown error. */
  readonly message: string
}
