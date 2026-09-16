import { rateVital, type VitalMetricName, type VitalRating, type VitalSample } from '~/types/vitals'

/**
 * A bounded, in-process rolling summary of the vitals this instance received.
 *
 * It exists so that "no analytics sink configured" is a working mode rather than
 * a hole. Without it, a deployment with no `NUXT_VITALS_SINK_URL` would collect
 * metrics in every visitor's browser, send them, and drop them — the failure the
 * outbox notes refuse to ship (`docs/outbox.md`), for the same reason. With it,
 * `GET /api/vitals/summary` always has something to show, `pnpm dev` is
 * inspectable without an account anywhere, and the forwarding sink becomes the
 * thing you add when you want history rather than the thing that makes the
 * feature work at all.
 *
 * ## What it is not
 *
 * **It is not storage.** Everything here is per-process memory: two instances
 * hold two different summaries, a deploy discards both, and a window holds the
 * last {@link VitalsAggregateOptions.maxSamplesPerKey} samples per route and
 * metric rather than a time range. That is stated plainly in the snapshot —
 * `retained` and `seen` are separate numbers — so a reader cannot mistake it for
 * a dataset. Anything that needs history, cross-instance totals, or a window
 * measured in days wants the forwarding sink and a real analytics backend.
 *
 * It is deliberately not on `useStorage()` either. A shared Redis copy would
 * make every beacon a network round trip in the request path, and it would still
 * not be a time series — it would be the same approximation with worse latency
 * and a new failure mode.
 *
 * ## Why p75
 *
 * A Core Web Vital is assessed at the 75th percentile of page loads, not the
 * mean: the metric is about the experience of a bad-but-not-freak visit, and a
 * mean lets a fast majority hide a slow quarter. `percentile` uses the
 * nearest-rank definition — the smallest retained value at or above 75% of the
 * ordered window — which needs no interpolation and returns a value that was
 * actually measured.
 */

/** Samples kept per (metric, route) before the oldest is overwritten. */
const DEFAULT_MAX_SAMPLES_PER_KEY = 200

/**
 * Distinct (metric, route) pairs tracked before the least recently updated is
 * evicted. Five metrics across forty routes; a route table larger than that
 * wants the forwarding sink.
 */
const DEFAULT_MAX_KEYS = 200

export interface VitalsAggregateOptions {
  readonly maxSamplesPerKey?: number
  readonly maxKeys?: number
  /** Injected so a test can assert on `lastSeenAt` without freezing the clock. */
  readonly now?: () => number
}

export interface VitalsKeySummary {
  readonly name: VitalMetricName
  readonly route: string
  /** Samples in the window the percentile was computed over. */
  readonly retained: number
  /** Samples this key has received since the process started, window or not. */
  readonly seen: number
  readonly p75: number
  /** The rating of {@link p75} — the number a Core Web Vitals assessment uses. */
  readonly rating: VitalRating
  /** Retained samples per rating, so a bimodal route is visible as one. */
  readonly distribution: Readonly<Record<VitalRating, number>>
  readonly lastSeenAt: string
}

export interface VitalsSnapshot {
  readonly generatedAt: string
  readonly keys: readonly VitalsKeySummary[]
  /** Samples currently held across every key. */
  readonly retainedSamples: number
  /** Samples received since the process started. */
  readonly seenSamples: number
  /** Keys dropped to stay under the cap. Non-zero means the summary is partial. */
  readonly evictedKeys: number
}

export interface VitalsAggregate {
  record: (sample: VitalSample) => void
  snapshot: () => VitalsSnapshot
}

interface KeyState {
  readonly name: VitalMetricName
  readonly route: string
  /** Ring buffer of the retained window, in arrival order. */
  readonly values: number[]
  /** Next write position in {@link values} once it is full. */
  cursor: number
  seen: number
  lastSeen: number
}

/**
 * The nearest-rank percentile of `values`, which is mutated by sorting.
 *
 * Exported for its own tests: an off-by-one here is invisible in a dashboard and
 * changes every number the summary reports. `p` is a fraction — `0.75` for p75.
 */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0
  const sorted = values.sort((a, b) => a - b)
  const rank = Math.ceil(p * sorted.length)
  // `rank` is 1-based and at least 1 for any p > 0; clamp covers p = 0 and
  // floating-point rounding at the top of the range.
  const index = Math.min(sorted.length - 1, Math.max(0, rank - 1))
  return sorted[index] as number
}

/** `CLS /pricing` — the pair a percentile is meaningful over. */
function keyOf(sample: VitalSample): string {
  return `${sample.name} ${sample.route}`
}

/**
 * Creates the aggregate. One per process; `useVitalsAggregate()` in
 * `server/utils/vitals-store.ts` owns the instance the ingest route writes to.
 */
export function createVitalsAggregate(options: VitalsAggregateOptions = {}): VitalsAggregate {
  const maxSamplesPerKey = Math.max(1, options.maxSamplesPerKey ?? DEFAULT_MAX_SAMPLES_PER_KEY)
  const maxKeys = Math.max(1, options.maxKeys ?? DEFAULT_MAX_KEYS)
  const now = options.now ?? Date.now

  const keys = new Map<string, KeyState>()
  let seenSamples = 0
  let evictedKeys = 0

  /**
   * Drops the least recently updated key. Least *recently updated* rather than
   * oldest-inserted: a route that stopped receiving traffic is the one whose
   * summary has stopped being about the present.
   */
  function evictOldest(): void {
    let oldestKey: string | undefined
    let oldestAt = Number.POSITIVE_INFINITY

    for (const [key, state] of keys) {
      if (state.lastSeen < oldestAt) {
        oldestAt = state.lastSeen
        oldestKey = key
      }
    }

    if (oldestKey !== undefined) {
      keys.delete(oldestKey)
      evictedKeys++
    }
  }

  return {
    record(sample) {
      const key = keyOf(sample)
      let state = keys.get(key)

      if (!state) {
        if (keys.size >= maxKeys) evictOldest()
        state = {
          name: sample.name,
          route: sample.route,
          values: [],
          cursor: 0,
          seen: 0,
          lastSeen: 0,
        }
        keys.set(key, state)
      }

      if (state.values.length < maxSamplesPerKey) {
        state.values.push(sample.value)
      } else {
        // Full: overwrite in place. A `shift()` would be O(n) per sample on the
        // hottest path this route has, and the window is a set, not a sequence —
        // nothing below depends on the order values sit in.
        state.values[state.cursor] = sample.value
        state.cursor = (state.cursor + 1) % maxSamplesPerKey
      }

      state.seen++
      state.lastSeen = now()
      seenSamples++
    },

    snapshot() {
      const summaries: VitalsKeySummary[] = []
      let retainedSamples = 0

      for (const state of keys.values()) {
        retainedSamples += state.values.length
        // Copied before `percentile` sorts it: the ring buffer's write cursor
        // indexes into `values`, and sorting in place would scatter the window.
        const p75 = percentile([...state.values], 0.75)

        summaries.push({
          name: state.name,
          route: state.route,
          retained: state.values.length,
          seen: state.seen,
          p75,
          rating: rateVital(state.name, p75),
          distribution: distributionOf(state.name, state.values),
          lastSeenAt: new Date(state.lastSeen).toISOString(),
        })
      }

      // Stable order so a dashboard polling this does not reshuffle its rows,
      // and so a test can assert on the array rather than on a set.
      summaries.sort((a, b) => a.name.localeCompare(b.name) || a.route.localeCompare(b.route))

      return {
        generatedAt: new Date(now()).toISOString(),
        keys: summaries,
        retainedSamples,
        seenSamples,
        evictedKeys,
      }
    },
  }
}

/** Retained samples per rating band. */
function distributionOf(
  name: VitalMetricName,
  values: readonly number[],
): Record<VitalRating, number> {
  const counts: Record<VitalRating, number> = { good: 0, 'needs-improvement': 0, poor: 0 }
  for (const value of values) counts[rateVital(name, value)]++
  return counts
}
