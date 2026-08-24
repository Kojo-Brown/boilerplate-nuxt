import type { NuxtConfig } from 'nuxt/schema'

/**
 * Nitro route rules — the per-route rendering and caching contract.
 *
 * Route rules are evaluated by Nitro against the *request path* (not the file
 * that serves it), so both pages and `server/` API routes are covered by the
 * same table. Rules are matched with rou3/radix semantics: an exact path wins
 * over a `/**` wildcard, and overlapping rules are merged, so keep the table
 * ordered from most general to most specific for readability.
 *
 * This object is imported by `nuxt.config.ts` and unit-tested in
 * `tests/unit/route-rules.test.ts`, which is the reason it lives in its own
 * module rather than inline in the config: the config file runs through
 * `defineNuxtConfig` and cannot be imported into the Node test environment
 * without dragging the whole Nuxt kit along with it.
 *
 * The four categories this boilerplate demonstrates:
 *
 *  - **prerender** — the route is rendered once at build time and written to
 *    `.output/public` as a static file. Zero server compute per request.
 *  - **swr** — stale-while-revalidate. Nitro caches the response for `maxAge`
 *    seconds; requests inside the window get the cached copy instantly, and the
 *    first request after it gets the stale copy while a background render
 *    refreshes the cache. Works on the Node preset this project builds with.
 *  - **isr** — Incremental Static Regeneration. The idiomatic Nuxt API for
 *    "cache like SWR, but let the deploy platform own the cache". On
 *    serverless/edge presets (Vercel, Netlify) it maps to platform-native ISR;
 *    on the Node preset it is treated as a cacheable route but is not itself a
 *    runtime cache — reach for `swr` when you need Node-side caching. See
 *    `docs/nitro-route-rules.md` for the measured behaviour on each preset.
 *  - **cors** — Nitro emits `Access-Control-Allow-Origin/Methods/Headers` for
 *    the route so a browser on another origin can call it. Applies to API
 *    routes, which are never gated by the app-level `auth.global` middleware.
 */
export const routeRules: NonNullable<NuxtConfig['routeRules']> = {
  // ── Pages ────────────────────────────────────────────────────────────────

  // Rendering-modes demo (see pages/rendering/). ISR here means SWR-style
  // caching of the SSR HTML — 60-second stale-while-revalidate.
  '/rendering/isr': { swr: 60 },

  // The route-rules index is a live SSR page that fetches the demo APIs to show
  // their caching behaviour. `prerender: false` keeps the prerender crawler from
  // freezing it into a static snapshot when it follows the back-link from the
  // prerendered child below.
  '/route-rules': { prerender: false },

  // Prerendered documentation page. Emitted as static HTML at build time; it is
  // on a public path (see middleware/auth.global.ts) so the build renders the
  // real page instead of a login redirect.
  '/route-rules/static': { prerender: true },

  // ── API routes ─────────────────────────────────────────────────────────────

  // SWR: cached for 30s, served stale-while-revalidate. The endpoint stamps
  // each render with a timestamp so the cache window is observable.
  '/api/route-rules/swr': { swr: 30 },

  // ISR: the documented Nuxt route rule for incremental regeneration. Kept
  // distinct from the SWR route so the two APIs can be compared on whichever
  // preset you deploy to.
  '/api/route-rules/isr': { isr: 60 },

  // CORS: a public, cross-origin-readable JSON endpoint. `cors: true` expands
  // to the permissive `Access-Control-Allow-*: *` set; the explicit `headers`
  // block narrows the allowed methods and adds a real (non-zero) preflight
  // cache, and takes precedence over the `cors` defaults on collision.
  '/api/route-rules/cors': {
    cors: true,
    headers: {
      'access-control-allow-methods': 'GET,OPTIONS',
      'access-control-max-age': '600',
    },
  },
}
