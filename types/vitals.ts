/**
 * Core Web Vitals: the wire format between the browser and the ingest route,
 * and the thresholds both halves rate against.
 *
 * ## Why the thresholds are copied here rather than imported
 *
 * `web-vitals` exports `CLSThresholds`, `LCPThresholds` and the rest, and the
 * browser half could read them directly. The server half cannot: `web-vitals`
 * is a browser library — its modules register `PerformanceObserver`s and read
 * `document` at import time — so importing it into a Nitro handler would pull
 * DOM code into the server bundle to obtain two numbers.
 *
 * The copy is not left to trust. `tests/unit/utils/webVitals.test.ts` asserts
 * {@link VITAL_THRESHOLDS} against the library's own exported arrays, so a
 * Google revision that ships in a `web-vitals` upgrade fails CI here instead of
 * quietly splitting the browser's rating from the server's.
 *
 * ## What a sample deliberately does not carry
 *
 * No user id, no session id, no URL query string, no user agent. A vitals beacon
 * is sent by every visitor on every page including logged-out ones, it is
 * forwarded to a third party, and none of those fields are needed to answer the
 * question this instrumentation exists for ("which routes are slow?"). The route
 * is a pathname with its query and hash removed by {@link routeFromUrl} in
 * `utils/webVitals.ts`; the server adds nothing to it. See `docs/web-vitals.md`.
 */

/**
 * The five metrics `web-vitals` v6 reports.
 *
 * FID is absent because it no longer exists: it was replaced by INP as a Core
 * Web Vital in March 2024 and removed from the library in v5. LCP, CLS and INP
 * are the three *Core* vitals; FCP and TTFB are diagnostics that explain a bad
 * LCP, and they are collected because a p75 LCP regression with no matching TTFB
 * movement is a different bug from one with it.
 */
export const VITAL_METRIC_NAMES = ['CLS', 'FCP', 'INP', 'LCP', 'TTFB'] as const

export type VitalMetricName = (typeof VITAL_METRIC_NAMES)[number]

/** Google's rating bands, as `[good, needsImprovement]` upper bounds. */
export type VitalThresholds = readonly [good: number, needsImprovement: number]

/**
 * `≤ good` is good, `≤ needsImprovement` is needs-improvement, above is poor.
 *
 * Units: CLS is a unitless layout-shift score, every other metric is
 * milliseconds.
 */
export const VITAL_THRESHOLDS: Readonly<Record<VitalMetricName, VitalThresholds>> = {
  CLS: [0.1, 0.25],
  FCP: [1800, 3000],
  INP: [200, 500],
  LCP: [2500, 4000],
  TTFB: [800, 1800],
}

export type VitalRating = 'good' | 'needs-improvement' | 'poor'

/**
 * The rating a value earns, by the same rule `web-vitals` applies.
 *
 * Used on the browser only as a cross-check of what the library already
 * computed; the real caller is the server, which rates the **p75** of a window
 * of samples. That is the number Google assesses a site on, and it is not the
 * average of the per-sample ratings — a route whose samples are half "good" and
 * half "poor" has a poor p75, and reporting it as "half good" would hide it.
 */
export function rateVital(name: VitalMetricName, value: number): VitalRating {
  const [good, needsImprovement] = VITAL_THRESHOLDS[name]
  if (value <= good) return 'good'
  if (value <= needsImprovement) return 'needs-improvement'
  return 'poor'
}

/**
 * How the page this metric belongs to was loaded.
 *
 * Mirrors `Metric['navigationType']` from `web-vitals`, which is the Navigation
 * Timing value plus the cases that API has no name for: a bfcache restore, a
 * prerender, a discarded-then-restored tab, and a soft navigation. Kept as a
 * literal union rather than `string` so the ingest schema can reject anything
 * else, and so a sink can split bfcache restores out — they are near-instant by
 * construction and would otherwise flatter every p75 they land in.
 */
export const VITAL_NAVIGATION_TYPES = [
  'navigate',
  'reload',
  'back-forward',
  'back-forward-cache',
  'prerender',
  'restore',
  'soft-navigation',
] as const

export type VitalNavigationType = (typeof VITAL_NAVIGATION_TYPES)[number]

/** One reported metric instance. */
export interface VitalSample {
  readonly name: VitalMetricName
  /** Milliseconds, or the unitless score for CLS. Never negative. */
  readonly value: number
  /** The browser's own rating of {@link value}, kept for comparison. */
  readonly rating: VitalRating
  /**
   * The library's per-instance id. A sink dedupes on it: the same metric is
   * reported repeatedly as its value grows (CLS accumulates, INP worsens), and
   * a page restored from the bfcache starts a new instance with a new id.
   */
  readonly id: string
  readonly navigationType: VitalNavigationType
  /**
   * Pathname the metric is attributed to, query and hash removed.
   *
   * Taken from the metric's own `navigationURL` where the browser supplies one,
   * not from wherever the SPA happens to be when the batch is flushed — those
   * differ for every metric that finalises after a client-side navigation.
   */
  readonly route: string
}

/** Page-scoped context, sent once per batch instead of on every sample. */
export interface VitalsPageContext {
  /**
   * Random per page load, so a sink can group the samples of one visit without
   * a cookie or a user id. It is generated in the browser, never stored, and
   * never reused across loads.
   */
  readonly visitId: string
  /**
   * `navigator.connection.effectiveType`, when the browser exposes it.
   *
   * The explicit `| undefined` is required by `exactOptionalPropertyTypes` in
   * `tsconfig.json`: the ingest schema's inferred type has it, and without it
   * here a parsed batch would not be assignable to {@link VitalsBatch}.
   */
  readonly connection?: string | undefined
  /** Viewport in CSS pixels. Explains a layout shift that mobile sees and desktop does not. */
  readonly viewport?: { readonly width: number; readonly height: number } | undefined
}

/** The POST body of `/api/vitals`. */
export interface VitalsBatch {
  readonly sentAt: string
  readonly page: VitalsPageContext
  readonly samples: readonly VitalSample[]
}

/** Where the browser POSTs a batch. */
export const VITALS_ENDPOINT = '/api/vitals'

/**
 * Hard ceiling on samples per batch, enforced on both ends.
 *
 * Five metrics, plus room for the extra instances a long-lived SPA session
 * produces — a soft navigation starts fresh LCP/CLS/INP instances, and a
 * bfcache restore starts another set. Twenty-four is comfortably above a real
 * page's output and small enough that a forged beacon is not a payload
 * amplifier. The browser flushes early rather than growing past it.
 */
export const MAX_SAMPLES_PER_BATCH = 24

/** What `/api/vitals` answers. Deliberately says whether anything was kept. */
export interface VitalsIngestResult {
  readonly accepted: number
  /** Which destinations took the batch: `forward`, `log`, `aggregate`. */
  readonly sinks: readonly string[]
}
