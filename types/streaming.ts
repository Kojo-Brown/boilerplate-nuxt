/**
 * The wire protocol for a streamed NDJSON response.
 *
 * A streamed response commits to its status code and headers with the first
 * byte. Everything after that is body, so a failure that happens on record 900
 * of 1000 cannot become a 500 — the client has already been told `200 OK`. The
 * only place left to report it is *inside* the body, which is what these frames
 * are for: every line of the response is one frame, and the last one says how
 * the stream ended.
 *
 *  - `item` — one record. `index` is its position, so a client can tell a
 *    re-delivered record from a new one.
 *  - `end` — the stream finished normally. Carries the totals the server
 *    knows and the client cannot compute (how many records it *meant* to send).
 *  - `error` — the source failed after the response had started. The stream is
 *    over; whatever `item` frames arrived before it are still valid.
 *
 * A response that stops without either terminator was truncated — a proxy
 * timeout, a killed process, a dropped connection. That is a different outcome
 * from both success and failure, and without a terminator frame it is
 * indistinguishable from success at the point where the reader sees the body
 * end. `useNdjsonStream` reports it as an error for exactly that reason.
 */

/** One record of the stream. */
export interface StreamItemFrame<T> {
  readonly type: 'item'
  /** Zero-based position in the stream. */
  readonly index: number
  readonly data: T
}

/** The stream finished normally. Always the last frame when it appears. */
export interface StreamEndFrame {
  readonly type: 'end'
  /** How many `item` frames preceded this one. */
  readonly count: number
  /** Wall-clock milliseconds from the first record to this frame. */
  readonly elapsedMs: number
}

/**
 * The source threw after the response had started. Always the last frame when
 * it appears.
 *
 * `message` is written for the client, not copied from the thrown error — see
 * `streamErrorFrame` in `server/utils/stream.ts`.
 */
export interface StreamErrorFrame {
  readonly type: 'error'
  readonly message: string
}

export type StreamFrame<T> = StreamItemFrame<T> | StreamEndFrame | StreamErrorFrame
