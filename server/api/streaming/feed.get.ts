import { abortableDelay, requestAbortSignal, sendNdjson } from '~/server/utils/stream'

/**
 * An NDJSON feed — the streaming demo behind `/streaming`.
 *
 * The handler is three lines because everything interesting is in the generator
 * and in `server/utils/stream.ts`. What it demonstrates:
 *
 *  - **Records arrive as they are produced.** `?delay=` puts real time between
 *    them, so the difference between this and a JSON array is visible rather
 *    than argued about: the first record is on screen while the last has not
 *    been generated.
 *  - **A failure mid-response is a frame, not a status.** `?failAt=` throws from
 *    the generator after some records have already been written. The response is
 *    still `200`, because it was `200` before the failure existed; the `error`
 *    frame is what tells the client.
 *  - **A disconnect stops the work.** The `finally` below runs when the client
 *    goes away, because `streamFromIterable` calls the generator's `return()`
 *    on abort. Stop the stream from the demo page and the dev server logs how
 *    far it had got. Without that call the loop would run to `count`, sleeping
 *    and yielding into a closed socket.
 *
 * The data is synthetic so the demo needs no database. A real feed replaces the
 * body of the loop with a cursor read and gets the same three properties, which
 * is the point of keeping the transport in a utility.
 */
export interface FeedItem {
  /** One-based, so it reads the same as the `count` query. */
  id: number
  label: string
  /** When the server produced this record. */
  emittedAt: string
  /** Milliseconds from the start of the stream to this record. */
  elapsedMs: number
}

/**
 * Query limits.
 *
 * `count` is clamped because the response is unbounded in time as well as size:
 * every record holds the connection open, and `sendStream` does not apply
 * backpressure (see `server/utils/stream.ts`), so an unclamped `?count=` is a
 * one-request way to make the process buffer. `delay` is clamped for the same
 * reason from the other side — a large one holds a socket open doing nothing.
 */
const MAX_COUNT = 50
const MAX_DELAY_MS = 1000
const DEFAULT_COUNT = 8
const DEFAULT_DELAY_MS = 250

export interface FeedQuery {
  readonly count: number
  readonly delayMs: number
  /** Record number to throw at, or `null` to run to completion. */
  readonly failAt: number | null
}

export default defineEventHandler((event) => {
  const query = readFeedQuery(getQuery(event))
  // One signal for both halves: the stream ends on abort, and the generator's
  // sleep gives up on it rather than running out the clock first.
  const signal = requestAbortSignal(event)

  return sendNdjson(event, feedItems(query, signal), { signal })
})

async function* feedItems(query: FeedQuery, signal: AbortSignal): AsyncGenerator<FeedItem> {
  const startedAt = Date.now()
  let emitted = 0

  try {
    for (let id = 1; id <= query.count; id++) {
      await abortableDelay(query.delayMs, signal)
      // `abortableDelay` resolves on abort instead of throwing, so this is the
      // check that ends the loop — and it is deliberately before the yield, so a
      // disconnected client is never generated for.
      if (signal.aborted) return

      if (id === query.failAt) {
        throw new Error(`synthetic failure at record ${id} (?failAt=${id})`)
      }

      emitted++
      yield {
        id,
        label: `Record ${id} of ${query.count}`,
        emittedAt: new Date().toISOString(),
        elapsedMs: Date.now() - startedAt,
      }
    }
  } finally {
    // Only on an early end. A stream that ran to completion is not news, and a
    // line per request is how a log stops being read.
    if (emitted < query.count) {
      console.warn(
        `[stream] /api/streaming/feed ended after ${emitted}/${query.count} records ` +
          `(${signal.aborted ? 'client disconnected' : 'source failed'})`,
      )
    }
  }
}

/**
 * Reads the query into {@link FeedQuery}, clamped.
 *
 * Takes the parsed query rather than the event so it is a pure function of its
 * input, which is what `tests/unit/server/streaming-feed.test.ts` pins: the
 * clamps are the only thing standing between a query string and an unbounded
 * response, so "an absurd `?count=` produces a bounded stream" is worth an
 * assertion rather than a reading of the code.
 */
export function readFeedQuery(query: Record<string, unknown>): FeedQuery {
  return {
    count: clampInteger(query['count'], DEFAULT_COUNT, 1, MAX_COUNT),
    delayMs: clampInteger(query['delay'], DEFAULT_DELAY_MS, 0, MAX_DELAY_MS),
    // `null` for anything that is not a record number, so an unparseable
    // `?failAt=` is "do not fail" rather than a number that happens to match.
    failAt: optionalInteger(query['failAt'], 1, MAX_COUNT),
  }
}

/** Reads one query value as an integer in range, falling back on anything else. */
function clampInteger(raw: unknown, fallback: number, min: number, max: number): number {
  const value = Number(raw)
  if (raw === undefined || raw === null || raw === '' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.floor(value)))
}

/** {@link clampInteger} with "absent or unusable" as a distinct outcome. */
function optionalInteger(raw: unknown, min: number, max: number): number | null {
  const value = Number(raw)
  if (raw === undefined || raw === null || raw === '' || !Number.isFinite(value)) return null
  return Math.min(max, Math.max(min, Math.floor(value)))
}
