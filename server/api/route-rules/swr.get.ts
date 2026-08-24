/**
 * SWR-cached endpoint.
 *
 * The `swr: 30` route rule (see route-rules.config.ts) makes Nitro cache this
 * response for 30 seconds and serve it stale-while-revalidate. Because the
 * handler stamps every *fresh* render with the current time, the timestamp
 * stays frozen for the duration of the cache window — that is how you can see
 * the rule working: hammer the endpoint and `renderedAt` only advances once per
 * window, not once per request.
 *
 * The handler itself knows nothing about caching; the rule is what turns it
 * into a cached route. That separation is the whole point of route rules.
 */
export interface RouteRuleSample {
  rule: 'swr' | 'isr' | 'cors'
  renderedAt: string
  random: number
  note: string
}

export default defineEventHandler((): RouteRuleSample => {
  return {
    rule: 'swr',
    renderedAt: new Date().toISOString(),
    random: Math.round(Math.random() * 1_000_000),
    note: 'Cached 30s with stale-while-revalidate. renderedAt is frozen for the cache window.',
  }
})
