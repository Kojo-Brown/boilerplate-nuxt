/**
 * Public, cross-origin-readable JSON endpoint.
 *
 * The `cors: true` route rule (see route-rules.config.ts) makes Nitro attach
 * `Access-Control-Allow-Origin: *` (and the matching methods/headers) so a page
 * served from another origin can `fetch()` this without a proxy. The rule is
 * applied by Nitro's route-rules middleware before the handler runs, so — like
 * every `server/` route — this endpoint is not affected by the app-level
 * `auth.global` middleware and is genuinely public.
 *
 * The payload is a small static dataset so the endpoint is a realistic example
 * of "a public API a third party consumes", not just an echo.
 */
export interface FrameworkFact {
  id: string
  name: string
  language: string
  firstReleased: number
}

export interface CorsSample {
  rule: 'cors'
  servedAt: string
  frameworks: FrameworkFact[]
}

const FRAMEWORKS: readonly FrameworkFact[] = [
  { id: 'nuxt', name: 'Nuxt', language: 'TypeScript', firstReleased: 2016 },
  { id: 'next', name: 'Next.js', language: 'TypeScript', firstReleased: 2016 },
  { id: 'sveltekit', name: 'SvelteKit', language: 'TypeScript', firstReleased: 2022 },
  { id: 'remix', name: 'Remix', language: 'TypeScript', firstReleased: 2021 },
]

export default defineEventHandler((): CorsSample => {
  return {
    rule: 'cors',
    servedAt: new Date().toISOString(),
    frameworks: [...FRAMEWORKS],
  }
})
