import { onCLS, onFCP, onINP, onLCP, onTTFB, type Metric } from 'web-vitals'

import { VITALS_ENDPOINT, type VitalsPageContext } from '~/types/vitals'
import {
  createBeaconTransport,
  createVitalsReporter,
  newVisitId,
  resolveVitalsClientOptions,
  shouldReportVisit,
  toVitalSample,
  type RawVitalsClientOptions,
} from '~/utils/webVitals'

/**
 * Subscribes to Core Web Vitals and beacons them to `/api/vitals`.
 *
 * Client-only by filename, and it has to be: every metric here is measured by a
 * `PerformanceObserver` against a real document. There is nothing to observe
 * during SSR, and `web-vitals` reads `document` at import time, so a server-side
 * import would fail before it could do nothing useful.
 *
 * All of the decisions live in `utils/webVitals.ts`, which is pure and unit
 * tested. What is left here is the part that cannot be: the library
 * subscriptions, the page-lifecycle listeners, and reading the live config.
 *
 * ## Why the flush is where it is
 *
 * On `visibilitychange` → hidden, and again on `pagehide`. That pair is the
 * modern replacement for `unload`, which mobile Safari does not fire and which
 * disqualifies a page from the bfcache merely by being listened for. `pagehide`
 * is not a duplicate of the first: a tab can be hidden and later shown again, so
 * a page may flush several times over its life, and each flush sends only what
 * accumulated since the last one.
 *
 * ## `reportAllChanges` stays off
 *
 * With it off — the default — each metric's callback fires once, when the value
 * is final (or when the page is hidden, whichever comes first). That is what a
 * beacon wants. With it on, CLS would call back on every layout shift, which is
 * useful for a live debug overlay and is pure overhead for a sink that only ever
 * keeps the last value per instance.
 *
 * `reportSoftNavs` is the opposite call and is on: without it, a Nuxt app
 * reports one set of vitals for the whole session — everything after the first
 * client-side navigation is attributed to the landing route, or not measured at
 * all. With it, each soft navigation starts fresh LCP/CLS/INP instances carrying
 * their own `navigationURL`, which is what `toVitalSample` attributes on. In a
 * browser without the Soft Navigations API the flag is inert rather than broken:
 * the library reports hard-navigation vitals exactly as it would have.
 */
export default defineNuxtPlugin({
  name: 'web-vitals',
  // Nothing downstream waits on this: it registers observers and returns. Running
  // it in parallel with the other plugins keeps it off the hydration path.
  parallel: true,
  setup() {
    const config = useRuntimeConfig()
    const options = resolveVitalsClientOptions(
      config.public.webVitals as RawVitalsClientOptions | undefined,
      { enabled: true, endpoint: VITALS_ENDPOINT, sampleRate: 1 },
    )

    if (!options.enabled) return
    if (!shouldReportVisit(options.sampleRate)) return

    const reporter = createVitalsReporter({
      transport: createBeaconTransport({
        endpoint: options.endpoint,
        // Bound, because `sendBeacon` throws an "illegal invocation" when it is
        // called detached from `navigator`.
        sendBeacon: navigator.sendBeacon?.bind(navigator),
        fetchImpl: globalThis.fetch,
      }),
      page: pageContext(),
    })

    const report = (metric: Metric) => {
      // `location.href` is read here, inside the callback, rather than at flush
      // time: a metric that finalises before a client-side navigation belongs to
      // the route it was measured on, not to wherever the app has since gone.
      reporter.record(toVitalSample(metric, location.href))
    }

    const reportOpts = { reportSoftNavs: true }

    onCLS(report, reportOpts)
    onFCP(report, reportOpts)
    onINP(report, reportOpts)
    onLCP(report, reportOpts)
    onTTFB(report, reportOpts)

    document.addEventListener(
      'visibilitychange',
      () => {
        if (document.visibilityState === 'hidden') reporter.flush()
      },
      // Passive: the listener never calls `preventDefault`, and saying so lets
      // the browser dispatch it without waiting to find out.
      { passive: true },
    )

    // Not redundant with the above. A page can be discarded without ever going
    // through `hidden` — a cross-origin navigation in some browsers — and
    // `pagehide` fires when the page enters the bfcache, where it may sit for
    // hours before being restored with new metric instances.
    window.addEventListener('pagehide', () => reporter.flush(), { passive: true })
  },
})

/**
 * Page-scoped context, sent once per batch rather than on every sample.
 *
 * Deliberately three fields. `navigator.connection` is not in the DOM lib
 * because it is not a cross-browser standard — Safari and Firefox do not
 * implement it — so it is read through a narrowed structural type and left
 * undefined where it is missing, rather than cast to `any`.
 */
function pageContext(): VitalsPageContext {
  interface NavigatorWithConnection extends Navigator {
    readonly connection?: { readonly effectiveType?: string }
  }

  const connection = (navigator as NavigatorWithConnection).connection?.effectiveType

  return {
    visitId: newVisitId(),
    ...(connection ? { connection } : {}),
    viewport: { width: window.innerWidth, height: window.innerHeight },
  }
}
