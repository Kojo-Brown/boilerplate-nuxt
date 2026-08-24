import type { RouteRuleSample } from './swr.get'

/**
 * ISR endpoint.
 *
 * The `isr: 60` route rule is the idiomatic Nuxt way to ask for Incremental
 * Static Regeneration. What it *does* depends on the deploy target:
 *
 *  - On serverless/edge presets (Vercel, Netlify) it maps to platform-native
 *    ISR: the first request renders and caches, later requests inside the
 *    window are served from the CDN, and the cache regenerates at most once per
 *    60 seconds.
 *  - On the Node preset this project builds with, `isr` is recognised as a
 *    cacheable route (payloads are extracted for it) but is not a runtime cache
 *    on its own — for Node-side caching use `swr`, demonstrated by the sibling
 *    `/api/route-rules/swr` route.
 *
 * The measured behaviour on each preset is documented in
 * `docs/nitro-route-rules.md`.
 */
export default defineEventHandler((): RouteRuleSample => {
  return {
    rule: 'isr',
    renderedAt: new Date().toISOString(),
    random: Math.round(Math.random() * 1_000_000),
    note: 'isr:60 — platform ISR on serverless/edge presets; a cacheable route on the Node preset.',
  }
})
