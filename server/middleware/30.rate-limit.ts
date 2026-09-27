import type { H3Event } from 'h3'

import { normalisePathname } from '~/server/utils/request-path'
import {
  consumeRateLimit,
  rateLimitHeaders,
  resolveRateLimitSettings,
  useRateLimitStore,
  RATE_LIMIT_ERROR_CODE,
  type RateLimitDecision,
  type RateLimitRuntimeConfig,
  type RateLimitSettings,
} from '~/server/utils/rate-limit'
import {
  rateLimitIdentity,
  rateLimitStoreKey,
  resolveClientIp,
  resolveRateLimitPolicy,
  type RateLimitMatch,
} from '~/server/utils/rate-limit-policy'

/**
 * The rate limiter, and the last gate before a route handler runs.
 *
 * Runs after `10.auth.ts` and `20.csrf.ts` (see the filename-ordering note in
 * `00.request-context.ts`). All of the judgement lives in
 * `server/utils/rate-limit.ts` and `server/utils/rate-limit-policy.ts`, both of
 * which are pure and unit-tested; this file is the four things that cannot be —
 * reading the request, reaching the store, writing headers, and throwing.
 *
 * ## Why it runs last
 *
 * Two orderings are defensible and this one is deliberate.
 *
 * It runs **after auth** because that is what makes a per-user quota possible at
 * all: `event.context.auth` does not exist until `10.auth.ts` has resolved it,
 * and keying a signed-in caller by IP would throttle everyone behind one office
 * NAT together. The cost is real and worth naming — a flood of requests still
 * pays for session unsealing and the session-registry read before it is refused,
 * which is precisely why the module note in `server/utils/rate-limit.ts` insists
 * this is not a DoS defence.
 *
 * It runs **after CSRF** because that gate is two header reads and at most one
 * HMAC, and because its answer is more specific: a forged request should be told
 * it was forged (403), not that it was too frequent. Quota is for requests that
 * are otherwise legitimate.
 *
 * ## What a limited request costs
 *
 * One storage read, and one write when it is admitted. That is the honest price
 * of this feature, and it is why the policy table leaves pages and assets alone:
 * a round trip per `.js` chunk would be pure overhead on traffic that is not
 * worth protecting here.
 *
 * ## Failure is open
 *
 * An unreachable store is logged and the request proceeds — the same stance
 * `10.auth.ts` takes for the session registry, and for the same reason. A limiter
 * that fails closed turns a Redis blip into a total outage, which is a far worse
 * incident than a window with no limiting in it.
 */
export default defineEventHandler(async (event) => {
  // Nothing about a prerender is a request from a caller: there is no address to
  // count against, and the one "client" is the build itself.
  if (import.meta.prerender === true) return

  const settings = resolveRateLimitSettings(useRuntimeConfig(event) as RateLimitRuntimeConfig)
  if (!settings.enabled) return

  const match = resolveRateLimitPolicy(normalisePathname(event.path))
  if (match === null) return

  warnAboutProxyOnce(settings)

  const decision = await consume(event, match, settings)
  // `null` is an unreachable store. It has already been logged; the request goes
  // through without headers, because a `RateLimit-Remaining` this request never
  // established would be a number the client would be entitled to believe.
  if (decision === null) return

  for (const [name, value] of Object.entries(rateLimitHeaders(decision))) {
    setResponseHeader(event, name, value)
  }

  if (decision.allowed) return

  throw createError({
    statusCode: 429,
    // Nitro's error handler defaults an unrecognised status to "Server Error",
    // which is wrong on both counts here: this is the client's doing and it is a
    // named status in RFC 6585. Stated so the reason phrase on the wire matches
    // the code.
    statusMessage: 'Too Many Requests',
    message:
      `Rate limit exceeded: ${decision.limit} requests per ${decision.windowSeconds}s. ` +
      `Retry in ${decision.retryAfterSeconds}s.`,
    data: {
      code: RATE_LIMIT_ERROR_CODE,
      limit: decision.limit,
      windowSeconds: decision.windowSeconds,
      retryAfterSeconds: decision.retryAfterSeconds,
      requestId: event.context.requestId,
    },
  })
})

/**
 * Resolves the caller, consumes from their bucket, and returns the decision —
 * or `null` when the store could not be reached.
 */
async function consume(
  event: H3Event,
  match: RateLimitMatch,
  settings: RateLimitSettings,
): Promise<RateLimitDecision | null> {
  const auth = event.context.auth
  const identity = rateLimitIdentity({
    // `auth` is absent on paths the access policy leaves `unmanaged`. Those are
    // not in the policy table either, so in practice a limited request has always
    // been through `10.auth.ts` — but the fallback is an IP-keyed bucket rather
    // than a crash, which is the right answer if the two tables ever diverge.
    userId: auth?.authenticated === true ? auth.user.id : null,
    clientIp: resolveClientIp({
      forwardedFor: getRequestHeader(event, 'x-forwarded-for'),
      socketAddress: event.node?.req?.socket?.remoteAddress,
      trustProxyHops: settings.trustProxyHops,
    }),
  })

  try {
    return await consumeRateLimit(useRateLimitStore(), {
      key: rateLimitStoreKey(match.rule, identity),
      policy: match.policy,
      now: Date.now(),
    })
  } catch (error) {
    console.error('[rate-limit] store unreachable, allowing request:', error)
    return null
  }
}

/** One warning per process, not one per request. */
let warnedAboutProxy = false

/**
 * Warns a built server that is counting socket addresses, once.
 *
 * `trustProxyHops: 0` is the only value that cannot be spoofed, so it is the
 * default — but behind a load balancer it means every caller arrives from the
 * balancer's address and shares one bucket, which looks from the outside like the
 * limiter refusing traffic at random. That is a configuration an operator has to
 * make a decision about, and this is the line that tells them so.
 *
 * Silent in dev, where connecting directly is the normal case and the default is
 * correct. See the long note in `resolveRateLimitSettings` for how to count hops.
 */
function warnAboutProxyOnce(settings: RateLimitSettings): void {
  if (warnedAboutProxy || import.meta.dev || settings.trustProxyHops > 0) return

  warnedAboutProxy = true
  console.warn(
    '[rate-limit] counting requests by socket address because ' +
      'NUXT_RATE_LIMIT_TRUST_PROXY_HOPS is 0. If this server sits behind a load balancer ' +
      "or CDN, every caller shares the proxy's bucket — set it to the number of proxies " +
      'in front of the app. See docs/rate-limiting.md.',
  )
}
