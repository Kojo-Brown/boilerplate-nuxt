import {
  MAX_SAMPLES_PER_BATCH,
  rateVital,
  VITAL_NAVIGATION_TYPES,
  type VitalMetricName,
  type VitalNavigationType,
  type VitalSample,
  type VitalsBatch,
  type VitalsPageContext,
} from '~/types/vitals'

/**
 * The browser half of Core Web Vitals reporting: everything between "the
 * `web-vitals` library called us back" and "bytes left the page".
 *
 * `plugins/web-vitals.client.ts` is the only caller. It is deliberately thin —
 * it subscribes to the library, owns the page-lifecycle listeners, and hands
 * work to the functions here — because none of that wiring can be unit-tested
 * and all of the decisions can.
 *
 * ## The one thing this code has to get right
 *
 * A vital is not known until the page is going away. LCP is not final until the
 * user interacts or the tab hides; CLS accumulates for the life of the page; INP
 * is the worst interaction so far and can only get worse. So the report is sent
 * during `visibilitychange` → hidden, which is the last callback a page is
 * reliably given — `unload` and `beforeunload` are not fired at all on mobile
 * Safari, and listening for them disqualifies the page from the bfcache.
 *
 * That constraint is what shapes the transport: at the moment of sending, the
 * document may never run JavaScript again, so nothing may depend on a promise
 * resolving, a retry, or a response being read. `navigator.sendBeacon` hands the
 * request to the browser process, which delivers it after the page is gone. See
 * {@link createBeaconTransport}.
 *
 * ## No module state
 *
 * `utils/**` is evaluated once per server process and its exports are reachable
 * from every request (`docs/composable-design-rules.md`), so the buffer lives in
 * a closure created by {@link createVitalsReporter} rather than at module scope.
 * The plugin is `.client`-only and would never actually run on the server, but
 * the rule is worth keeping unbroken: it is enforced by
 * `composable-design/no-module-state` and this file is not special.
 */

/** A metric as `web-vitals` reports it, narrowed to the fields that are sent. */
export interface VitalMetricReport {
  readonly name: VitalMetricName
  readonly value: number
  readonly id: string
  /** Widened to `string`: the library's union may gain members before we do. */
  readonly navigationType: string
  /** Present for soft navigations, and in browsers that expose it. */
  readonly navigationURL?: string
}

/** What a reporter does with a finished batch. `false` = not taken, keep it. */
export type VitalsTransport = (batch: VitalsBatch) => boolean

/**
 * Decimal places kept per metric.
 *
 * CLS is a small unitless score where the difference between 0.08 and 0.12 is
 * the difference between passing and failing, so four places are kept. Every
 * other metric is milliseconds, where the sub-millisecond digits
 * `PerformanceObserver` reports are precision the measurement does not have —
 * and, on a cross-origin-isolated page, precision deliberately coarsened by the
 * browser. Dropping them shortens the beacon and removes a fingerprinting
 * surface for nothing of value.
 */
const VALUE_PRECISION = {
  CLS: 4,
  FCP: 0,
  INP: 0,
  LCP: 0,
  TTFB: 0,
} as const

/**
 * Rounds a metric value to the precision its unit justifies.
 *
 * Negative input is clamped to zero rather than dropped: `TTFB` is computed from
 * timestamps that a clock adjustment can make go backwards, and a route losing
 * its whole sample for that is worse than one zero in the window.
 */
export function normaliseVitalValue(name: VitalMetricName, value: number): number {
  if (!Number.isFinite(value) || value < 0) return 0
  const factor = 10 ** VALUE_PRECISION[name]
  return Math.round(value * factor) / factor
}

/**
 * The pathname of `url`, with the query string and hash removed.
 *
 * Two reasons, and the privacy one is the smaller: a query string routinely
 * carries a search term, an email address in a signup link, or a session token
 * in a badly built one, and none of that belongs in a beacon forwarded to a
 * third party. The larger reason is cardinality — grouping by full URL gives one
 * bucket per visitor, and a p75 over a bucket of one is that visitor's number,
 * not the route's.
 *
 * Falls back to `/` for an unparseable value, because a sample is still worth
 * having with an unknown route and this runs on a page that is unloading.
 */
export function routeFromUrl(url: string): string {
  try {
    return new URL(url, 'http://localhost').pathname || '/'
  } catch {
    return '/'
  }
}

/**
 * Turns a library callback into a wire sample.
 *
 * `fallbackUrl` is used only when the metric carries no `navigationURL` of its
 * own; pass `location.href` as read *inside the callback*, not at flush time.
 * After a client-side navigation those are different URLs, and the metric
 * belongs to the one it was measured on.
 *
 * The rating is recomputed from the rounded value rather than copied from the
 * library's `metric.rating`, which describes the unrounded one. They agree
 * except within a rounding step of a threshold, and there the shipped rating has
 * to match the shipped value or a sink that rates the number itself — the
 * aggregate in `server/utils/vitals-aggregate.ts` does exactly that — disagrees
 * with the field it was sent next to.
 */
export function toVitalSample(metric: VitalMetricReport, fallbackUrl: string): VitalSample {
  const value = normaliseVitalValue(metric.name, metric.value)

  return {
    name: metric.name,
    value,
    rating: rateVital(metric.name, value),
    id: metric.id,
    navigationType: toNavigationType(metric.navigationType),
    route: routeFromUrl(metric.navigationURL ?? fallbackUrl),
  }
}

/**
 * Unknown navigation types degrade to `navigate` rather than losing the sample.
 *
 * A linear scan of seven `as const` strings rather than a module-scope `Set`,
 * which `composable-design/no-module-state` forbids here for good reason: a
 * container at module scope in `utils/` is shared by every request a server
 * process handles. At this size the scan is also simply faster.
 */
function toNavigationType(value: string): VitalNavigationType {
  return VITAL_NAVIGATION_TYPES.includes(value as VitalNavigationType)
    ? (value as VitalNavigationType)
    : 'navigate'
}

export interface VitalsReporter {
  /** Buffers a sample, replacing any earlier report of the same metric instance. */
  record: (sample: VitalSample) => void
  /**
   * Sends everything buffered, if anything is. Returns whether a batch left the
   * page; a transport that refused keeps its samples for the next attempt.
   */
  flush: () => boolean
  /** Samples currently buffered. Exported for tests and the dev page. */
  pending: () => number
}

export interface VitalsReporterOptions {
  readonly transport: VitalsTransport
  readonly page: VitalsPageContext
  /** Injected so a test does not have to freeze the clock globally. */
  readonly now?: () => Date
  /** Defaults to {@link MAX_SAMPLES_PER_BATCH}. */
  readonly maxSamples?: number
}

/**
 * Buffers samples and turns them into batches.
 *
 * ## Why it keys on the metric instance id
 *
 * The library reports a metric more than once. CLS grows as the page shifts, INP
 * worsens as the user finds a slower interaction, and with `reportAllChanges`
 * each of those is a callback. Every report of one instance carries the same
 * `id` and supersedes the last, so the buffer is a map keyed on it: the batch
 * then holds the final value per instance rather than a history, and a flush
 * that happens mid-page does not commit a CLS that is still accumulating to a
 * sink that would count it separately from the final one.
 *
 * Insertion order is preserved — a `Map` keeps it — so a batch reads in the
 * order the metrics finalised.
 *
 * ## Why a refused flush keeps the samples
 *
 * `navigator.sendBeacon` returns `false` when the browser's beacon queue is over
 * its limit, which is a real outcome on a page that sends several. Clearing the
 * buffer regardless would silently drop them; keeping them means the next flush
 * — the `pagehide` that follows a `visibilitychange`, usually — carries them
 * instead.
 */
export function createVitalsReporter(options: VitalsReporterOptions): VitalsReporter {
  const maxSamples = Math.max(1, options.maxSamples ?? MAX_SAMPLES_PER_BATCH)
  const now = options.now ?? (() => new Date())
  const buffered = new Map<string, VitalSample>()

  function flush(): boolean {
    if (buffered.size === 0) return false

    const samples = [...buffered.values()]
    const batch: VitalsBatch = {
      sentAt: now().toISOString(),
      page: options.page,
      samples,
    }

    const sent = options.transport(batch)
    if (sent) buffered.clear()
    return sent
  }

  return {
    record(sample) {
      buffered.set(sample.id, sample)
      // Flushing on overflow rather than evicting: the samples are all real and
      // a page that produced this many is one with something worth seeing.
      if (buffered.size >= maxSamples) flush()
    },
    flush,
    pending: () => buffered.size,
  }
}

export interface BeaconTransportOptions {
  readonly endpoint: string
  /** `navigator.sendBeacon`, bound. Absent in older browsers and in tests. */
  readonly sendBeacon?: (url: string, data: BodyInit) => boolean
  /** Fallback for browsers without `sendBeacon`. */
  readonly fetchImpl?: typeof globalThis.fetch
}

/**
 * Beacon first, `fetch(…, { keepalive: true })` second.
 *
 * `sendBeacon` is the right call: the request is handed to the browser process
 * and survives the page, it is exempt from the "no new work while unloading"
 * rules that make a plain `fetch` unreliable there, and it cannot be delayed by
 * the page's own main thread because the page is gone.
 *
 * What it costs is expressiveness. A beacon is a POST, it cannot carry headers,
 * and its outcome is one boolean — "queued" or "not queued", never a status
 * code. Nothing here depends on the response, so that is an acceptable trade and
 * `/api/vitals` is built for it: no auth, no custom header, no meaningful body
 * to read back.
 *
 * The body is a `Blob` with an explicit `application/json` type, because a
 * `string` passed to `sendBeacon` is sent as `text/plain;charset=UTF-8` and
 * `readValidatedBody` would then refuse to parse it. The same-origin endpoint is
 * what keeps that content type from triggering a CORS preflight the unloading
 * page could not complete.
 *
 * The `fetch` fallback returns `true` optimistically. It has to: a keepalive
 * fetch resolves after the page is gone and there is no one left to tell.
 */
export function createBeaconTransport(options: BeaconTransportOptions): VitalsTransport {
  return (batch) => {
    const body = JSON.stringify(batch)

    if (options.sendBeacon) {
      return options.sendBeacon(options.endpoint, new Blob([body], { type: 'application/json' }))
    }

    const doFetch = options.fetchImpl
    if (!doFetch) return false

    void doFetch(options.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      keepalive: true,
    }).catch(() => {
      // Nothing to do about it and nowhere to report it: the page is unloading.
      // Vitals are best-effort by construction — see the module comment.
    })

    return true
  }
}

/**
 * Whether this page load reports at all.
 *
 * Sampled per **visit**, not per metric. A per-metric decision would ship
 * batches missing an arbitrary subset of the five, which shows up in the data as
 * routes whose LCP and TTFB counts differ for no reason. Deciding once per load
 * keeps every retained visit complete.
 *
 * `random` is injected so the decision is testable; the plugin passes
 * `Math.random`. `Math.random()` is uniform on [0, 1), so `< rate` retains
 * exactly `rate` of loads — and `rate: 0` retains none, since nothing is below
 * zero.
 */
export function shouldReportVisit(sampleRate: number, random: () => number = Math.random): boolean {
  if (sampleRate >= 1) return true
  if (sampleRate <= 0) return false
  return random() < sampleRate
}

/**
 * An id for this page load, used to group a visit's samples at the sink.
 *
 * `crypto.randomUUID` is present in every browser this project supports, but
 * only in a **secure context** — over plain HTTP on a LAN address, which is how
 * a phone reaches `pnpm dev` on a laptop, `crypto` exists and `randomUUID` does
 * not. The fallback is `Math.random`, which is fine here: this id groups a
 * visit's own beacons and nothing else. It is not a token, it is never stored,
 * and a collision would merge two anonymous visits in a chart.
 */
export function newVisitId(
  // `null` rather than `undefined` for "no crypto here": a default parameter is
  // applied to `undefined`, so a test could not otherwise ask for the fallback
  // on a platform whose `globalThis.crypto` does have `randomUUID`.
  cryptoImpl: Pick<Crypto, 'randomUUID'> | null = globalThis.crypto ?? null,
): string {
  if (typeof cryptoImpl?.randomUUID === 'function') return cryptoImpl.randomUUID()
  return `v-${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`
}

export interface VitalsClientOptions {
  readonly enabled: boolean
  readonly endpoint: string
  /** Retained fraction of page loads, clamped to 0…1. */
  readonly sampleRate: number
}

/**
 * The shape `runtimeConfig.public.webVitals` arrives in, before coercion.
 *
 * Every field may be a string: a `NUXT_PUBLIC_*` environment variable overriding
 * a runtime-config default arrives as one unless Nuxt's coercion recognises the
 * default's type, and `"0.1"` handed to `shouldReportVisit` would compare as a
 * string and retain every load.
 */
export interface RawVitalsClientOptions {
  readonly enabled?: boolean | string
  readonly endpoint?: string
  readonly sampleRate?: number | string
}

/**
 * Coerces and clamps the public config.
 *
 * An unparseable sample rate falls back to `1` rather than to `0`: the failure
 * mode of "someone typo'd NUXT_PUBLIC_WEB_VITALS_SAMPLE_RATE" should be visible
 * in the data as too much of it, not as a dashboard that is silently empty.
 * `enabled` is the opposite — it is the off switch, and `"false"` from the
 * environment has to mean off.
 */
export function resolveVitalsClientOptions(
  raw: RawVitalsClientOptions | undefined,
  defaults: VitalsClientOptions,
): VitalsClientOptions {
  const enabled =
    typeof raw?.enabled === 'string' ? raw.enabled.trim() !== 'false' : (raw?.enabled ?? true)

  const endpoint = raw?.endpoint?.trim() || defaults.endpoint

  const parsedRate = typeof raw?.sampleRate === 'string' ? Number(raw.sampleRate) : raw?.sampleRate
  const sampleRate =
    parsedRate === undefined || !Number.isFinite(parsedRate)
      ? defaults.sampleRate
      : Math.min(1, Math.max(0, parsedRate))

  return { enabled, endpoint, sampleRate }
}
