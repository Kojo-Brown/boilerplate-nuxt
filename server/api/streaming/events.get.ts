import { abortableDelay, requestAbortSignal } from '~/server/utils/stream'
import { parseResumeToken, resumeFrom, sendSse } from '~/server/utils/sse'
import type { SseMessage } from '~/types/sse'

/**
 * A Server-Sent Events ticker — the SSE counterpart to the NDJSON feed next
 * door.
 *
 * Read it with the browser's own client, which is the reason to reach for SSE
 * over the NDJSON route in the first place:
 *
 * ```ts
 * const source = new EventSource('/api/streaming/events?count=20')
 * source.addEventListener('tick', (ev) => console.log(JSON.parse(ev.data)))
 * source.addEventListener('done', () => source.close())
 * ```
 *
 * `close()` on `done` is not tidiness. `EventSource` reconnects whenever the
 * body ends, so a client that does not close on the terminator restarts the
 * stream forever — see `SSE_DONE_EVENT` in `types/sse.ts`.
 *
 * What the query flags are for:
 *
 *  - `?delay=` puts real time between messages, so the heartbeat is observable.
 *  - `?heartbeat=` shortens the idle gap from the 15-second default to something
 *    a demo can wait for. Set it below `delay` and every message is preceded by
 *    one or more `: ping` comments, which is what a proxy sees and a client
 *    never does.
 *  - `?failAt=` throws from the generator after some messages have been
 *    delivered. The response is still `200`, because it was `200` before the
 *    failure existed; the `stream-error` event is what tells the client.
 *  - `?dropAt=` ends the response *without* a terminator — at the transport
 *    level, not by returning from the generator, which `sseBlocks` cannot
 *    distinguish from a source that finished. It imitates the proxy timeout
 *    the heartbeat exists to prevent. The client reconnects by itself
 *    and sends `Last-Event-ID`, and the messages it gets next are the ones it
 *    had not seen — which is the property worth demonstrating, because it is the
 *    one an endpoint silently fails to have.
 *
 * ## Auth
 *
 * This route inherits the `/api/**` default in `server/utils/access-policy.ts`,
 * so it requires a session. That works with `EventSource` only because the
 * connection is same-origin and carries cookies by default; cross-origin it
 * needs `withCredentials: true` on the client *and* CORS on the route, and there
 * is no way to attach a bearer token, since `EventSource` cannot set headers.
 * An SSE endpoint that has to authenticate a third-party caller wants a token in
 * the query string or a WebSocket instead.
 *
 * The data is synthetic so the demo needs no database. A real stream replaces
 * the body of the loop with a subscription and keeps every property, which is
 * the point of holding the transport in `server/utils/sse.ts`.
 */
export interface TickEvent {
  /** Monotonic sequence number, also the SSE `id` — the resume point. */
  seq: number
  label: string
  /** When the server produced this message. */
  emittedAt: string
  /** Milliseconds from the start of this connection to this message. */
  elapsedMs: number
  /** True when this connection began from a `Last-Event-ID`. */
  resumed: boolean
}

/** The event name every data message carries. Not `message`; see the doc above. */
export const TICK_EVENT = 'tick'

/**
 * Query limits.
 *
 * The clamps are what stand between a query string and a connection that is
 * unbounded in both size and time, and they matter more here than on the NDJSON
 * feed: `EventSource` reconnects on its own, so an endpoint that can be made
 * expensive can be made expensive repeatedly without the caller doing anything.
 * `heartbeat` has a floor as well as a ceiling because a one-millisecond
 * keepalive is a busy loop writing to a socket.
 */
const MAX_COUNT = 100
const DEFAULT_COUNT = 10
const MAX_DELAY_MS = 2_000
const DEFAULT_DELAY_MS = 500
const MIN_HEARTBEAT_MS = 100
const MAX_HEARTBEAT_MS = 60_000
const DEFAULT_DEMO_HEARTBEAT_MS = 2_000

export interface EventsQuery {
  /** How many messages this connection will deliver at most. */
  readonly count: number
  readonly delayMs: number
  readonly heartbeatMs: number
  /** Sequence number to throw at, or `null` to run to completion. */
  readonly failAt: number | null
  /** Sequence number to end the body at with no terminator, or `null`. */
  readonly dropAt: number | null
  /** Sequence number the client last saw, or `null` for a fresh connection. */
  readonly resumeAfter: number | null
}

export default defineEventHandler((event) => {
  const query = readEventsQuery(getQuery(event), resumeFrom(event))
  // One signal for both halves: the response ends on abort, and the generator's
  // sleep gives up on it rather than running out the clock first.
  const clientGone = requestAbortSignal(event)

  /**
   * The transport-level end `?dropAt=` needs.
   *
   * Returning from the generator does not truncate anything: `sseBlocks` cannot
   * tell a source that gave up from one that finished, so it writes the `done`
   * terminator — the exact block this flag exists to withhold. Ending the
   * *response* is what a proxy timeout does, and aborting is how this codebase
   * already says that, so the flag reuses it rather than inventing a second
   * path through the stream.
   */
  const cutoff = new AbortController()
  const signal = AbortSignal.any([clientGone, cutoff.signal])

  return sendSse(event, tickMessages(query, signal, cutoff), {
    signal,
    heartbeatMs: query.heartbeatMs,
  })
})

async function* tickMessages(
  query: EventsQuery,
  signal: AbortSignal,
  cutoff: AbortController,
): AsyncGenerator<SseMessage<TickEvent>> {
  const startedAt = Date.now()
  const first = (query.resumeAfter ?? 0) + 1
  const last = first + query.count - 1
  let emitted = 0
  let dropped = false

  try {
    for (let seq = first; seq <= last; seq++) {
      await abortableDelay(query.delayMs, signal)
      // `abortableDelay` resolves on abort instead of throwing, so this is the
      // check that ends the loop — deliberately before the yield, so a
      // disconnected client is never generated for.
      if (signal.aborted) return

      if (seq === query.failAt) {
        throw new Error(`synthetic failure at message ${seq} (?failAt=${seq})`)
      }

      if (seq === query.dropAt) {
        dropped = true
        cutoff.abort()
        return
      }

      emitted++
      yield {
        event: TICK_EVENT,
        // The `id` is what the browser replays as `Last-Event-ID`. Emitting one
        // per message is the entire cost of being resumable.
        id: String(seq),
        data: {
          seq,
          label: `Tick ${seq}`,
          emittedAt: new Date().toISOString(),
          elapsedMs: Date.now() - startedAt,
          resumed: query.resumeAfter !== null,
        },
      }
    }
  } finally {
    // Only on an early end. A connection that ran to completion is not news,
    // and a line per request is how a log stops being read.
    if (emitted < query.count) {
      console.warn(
        `[sse] /api/streaming/events ended after ${emitted}/${query.count} messages ` +
          `(${describeEnding(dropped, signal.aborted)})`,
      )
    }
  }
}

/**
 * Why the connection ended, for the log line above.
 *
 * `dropped` is checked first because the cutoff aborts the shared signal too, so
 * after `?dropAt=` both conditions are true and only the more specific one is
 * worth reading.
 */
function describeEnding(dropped: boolean, aborted: boolean): string {
  if (dropped) return 'truncated by ?dropAt='
  return aborted ? 'client disconnected' : 'source stopped'
}

/**
 * Reads the query and the resume header into {@link EventsQuery}, clamped.
 *
 * Takes the parsed query and the raw resume token rather than the event so it is
 * a pure function of its input, which is what
 * `tests/unit/server/streaming-events.test.ts` pins: the clamps are the only
 * thing standing between a query string and an unbounded connection.
 */
export function readEventsQuery(
  query: Record<string, unknown>,
  resumeToken: string | null,
): EventsQuery {
  return {
    count: clampInteger(query['count'], DEFAULT_COUNT, 1, MAX_COUNT),
    delayMs: clampInteger(query['delay'], DEFAULT_DELAY_MS, 0, MAX_DELAY_MS),
    heartbeatMs: clampInteger(
      query['heartbeat'],
      DEFAULT_DEMO_HEARTBEAT_MS,
      MIN_HEARTBEAT_MS,
      MAX_HEARTBEAT_MS,
    ),
    failAt: optionalInteger(query['failAt']),
    dropAt: optionalInteger(query['dropAt']),
    resumeAfter: parseResumeAfter(resumeToken),
  }
}

/**
 * Reads a `Last-Event-ID` back into the sequence number that produced it.
 *
 * The ids this route emits are decimal integers, but the header is whatever the
 * client sends — it round-trips a value from a *previous* deployment of this
 * endpoint, or from a different one behind the same path. Anything that is not
 * one of our ids resumes from the beginning, which loses the client's position
 * but never invents one.
 */
export function parseResumeAfter(raw: string | null): number | null {
  const token = parseResumeToken(raw)
  if (token === null || !/^\d+$/.test(token)) return null
  const seq = Number(token)
  // `/^\d+$/` admits integers past `Number.MAX_SAFE_INTEGER`, where `seq + 1`
  // stops being a distinct number and the loop below would never advance.
  if (!Number.isSafeInteger(seq)) return null
  return seq
}

/** Reads one query value as an integer in range, falling back on anything else. */
function clampInteger(raw: unknown, fallback: number, min: number, max: number): number {
  const value = Number(raw)
  if (raw === undefined || raw === null || raw === '' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.floor(value)))
}

/**
 * {@link clampInteger} with "absent or unusable" as a distinct outcome.
 *
 * Unclamped, unlike the feed's: these are sequence numbers, and after a resume
 * the live range is `resumeAfter + 1 … resumeAfter + count` rather than
 * `1 … count`. Clamping them to the latter would make `?failAt=` and `?dropAt=`
 * silently unreachable on every reconnect, which is exactly the request they
 * exist to be used on.
 */
function optionalInteger(raw: unknown): number | null {
  const value = Number(raw)
  if (raw === undefined || raw === null || raw === '' || !Number.isFinite(value)) return null
  return Math.floor(value)
}
