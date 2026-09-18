import type { BudgetConfig } from './scripts/bundleBudget.ts'

/** Budgets read in kilobytes and are compared in bytes. */
const kB = (value: number): number => Math.round(value * 1024)

/**
 * What each route is allowed to make a browser download before it can hydrate.
 *
 * Both numbers on every line are **gzipped bytes**, and both are measured:
 *
 *  - `totalGzipBytes` — the whole initial payload for that route, shared
 *    baseline included. This is the number a visitor waits for.
 *  - `routeGzipBytes` — what the route adds on top of the baseline. This is the
 *    number a page's own author controls, and the one that moves when a page
 *    imports something heavy.
 *
 * Splitting them matters because the two fail for different reasons. A page
 * that imports a charting library breaks its own line. A component added to
 * `app.vue`, a plugin, or a store that every page touches breaks the shared
 * baseline and every line at once — and the gate says which of the two
 * happened rather than reporting twenty-three failures that share one cause.
 *
 * ## Where the numbers come from
 *
 * Each one is what the route measured when the budget was written, plus the
 * larger of 5% and 2 kB for a total, or 5% and 512 B for a route's own share,
 * rounded up to a readable figure. The absolute floor is there because the
 * route-only numbers are small: 5% of 1.05 kB is 54 bytes, which is inside the
 * range two Node majors' zlib builds can differ by, and a gate that fails on
 * compressor noise gets muted rather than fixed.
 *
 * ## Changing a number here
 *
 * These are ceilings, not targets. When the gate fails, the first question is
 * whether the growth was intended. If it was — a route genuinely needs a new
 * dependency — raise that line and say why in the commit; it reads in review as
 * what it is, a decision to ship more JavaScript. If it was not, the report
 * names the chunks, and `pnpm bundle:budget` prints the same table locally
 * against `.output/`.
 *
 * Adding a page requires adding a line here: the gate fails on a route it has
 * no budget for, and on a budget with no route behind it. A budget table that
 * silently stops covering things reads like coverage without being any.
 */
export const bundleBudgets: BudgetConfig = {
  /**
   * The entry chunk's closure — Vue, the Nuxt runtime, vue-router, vue-i18n,
   * Pinia, the color-mode plugin, the app shell and `entry.css`. Every route
   * pays it, so it is the most valuable number in this file to keep from
   * drifting: 10 kB added here is 10 kB added twenty-three times.
   */
  sharedGzipBytes: kB(145),

  routes: {
    '/': { totalGzipBytes: kB(147), routeGzipBytes: kB(2.5) },
    '/async-data-cache': { totalGzipBytes: kB(149), routeGzipBytes: kB(4.75) },
    '/cached-functions': { totalGzipBytes: kB(147), routeGzipBytes: kB(2.75) },
    '/custom-ref': { totalGzipBytes: kB(148), routeGzipBytes: kB(3.75) },
    '/data-patterns': { totalGzipBytes: kB(148), routeGzipBytes: kB(3.5) },
    '/dependency-inversion': { totalGzipBytes: kB(153), routeGzipBytes: kB(8.25) },
    '/effect-scope': { totalGzipBytes: kB(148), routeGzipBytes: kB(3.5) },
    '/islands': { totalGzipBytes: kB(152), routeGzipBytes: kB(7.25) },
    '/login': { totalGzipBytes: kB(147), routeGzipBytes: kB(2.5) },
    '/reactivity-performance': { totalGzipBytes: kB(149), routeGzipBytes: kB(4.25) },
    '/reactivity-pitfalls': { totalGzipBytes: kB(148), routeGzipBytes: kB(3.25) },
    '/render-functions': { totalGzipBytes: kB(150), routeGzipBytes: kB(4.75) },
    '/rendering': { totalGzipBytes: kB(147), routeGzipBytes: kB(2.5) },
    '/rendering/isr': { totalGzipBytes: kB(147), routeGzipBytes: kB(2.25) },
    '/rendering/spa': { totalGzipBytes: kB(147), routeGzipBytes: kB(2.5) },
    '/rendering/ssg': { totalGzipBytes: kB(147), routeGzipBytes: kB(2.25) },
    '/rendering/ssr': { totalGzipBytes: kB(147), routeGzipBytes: kB(2) },
    '/route-rules': { totalGzipBytes: kB(147), routeGzipBytes: kB(2.5) },
    '/route-rules/static': { totalGzipBytes: kB(146), routeGzipBytes: kB(1.75) },
    '/streaming': { totalGzipBytes: kB(148), routeGzipBytes: kB(3.25) },
    '/ui-primitives': { totalGzipBytes: kB(149), routeGzipBytes: kB(4.25) },
    '/upload': { totalGzipBytes: kB(147), routeGzipBytes: kB(2.5) },
    '/websockets': { totalGzipBytes: kB(150), routeGzipBytes: kB(5.25) },
  },
}

/**
 * Where `modules/bundle-budget.ts` writes the client manifest, and where
 * `scripts/assert-bundle-budget.ts` looks for it — relative to the project
 * root, and gitignored.
 *
 * Deliberately not under Nuxt's `buildDir`: that moved from `.nuxt/` to
 * `node_modules/.cache/nuxt/.nuxt/` in Nuxt 4, which is a cache directory a
 * `pnpm store prune` or a cold CI runner is entitled to empty. A directory of
 * our own is one Nuxt internal less to depend on.
 */
export const CLIENT_MANIFEST_PATH = '.bundle-budget/client-manifest.json'

/** Where the gate writes its JSON report, relative to the project root. */
export const REPORT_PATH = '.bundle-budget/report.json'
