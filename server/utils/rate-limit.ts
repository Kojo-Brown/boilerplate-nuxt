import type { Storage } from 'unstorage'

import { RATE_LIMIT_BASE } from '~/server/utils/storage'

/**
 * Rate limiting: the algorithm, the settings, and the store it runs on.
 *
 * `server/utils/rate-limit-policy.ts` decides *which* limit a path gets and
 * *whose* quota it comes out of. This file is everything after that: one bucket,
 * one arrival, allow or refuse.
 *
 * ## What this protects, and what it does not
 *
 * Worth being exact about, because "rate limiting" is used for two different
 * jobs and this is only one of them.
 *
 * This is an **application** limiter. It bounds how often one caller may reach a
 * handler, which is what stops credential stuffing against `/api/auth/login`,
 * stops one client monopolising an expensive endpoint, and makes a quota
 * something the app can state rather than hope for.
 *
 * It is **not a DoS defence**, and deploying it as one would be a mistake. By
 * the time this middleware runs, the request has been accepted, parsed, routed,
 * and — on a managed path — had its session cookie unsealed and the session
 * registry consulted. A flood still pays for all of that. Volumetric defence
 * belongs in front of the application, where a request can be dropped before it
 * costs anything: an ALB rule, CloudFront, Cloudflare. `docs/rate-limiting.md`
 * says so where an operator will read it.
 *
 * ## The algorithm: GCRA, not a fixed window
 *
 * The obvious implementation is a counter per key per window: increment, compare
 * to the limit, expire the key after the window. It is rejected here for a
 * reason that shows up immediately in production — the **boundary burst**. A
 * caller limited to 300/minute can send 300 requests in the last instant of one
 * window and 300 in the first instant of the next, so the limit that reads as
 * "300 per minute" permits 600 inside one second. Every fixed-window limiter has
 * this property, and it is worst exactly where the limit is smallest and matters
 * most: a 5-per-5-minutes login limit becomes 10 attempts back to back.
 *
 * So this uses **GCRA** (the Generic Cell Rate Algorithm), which is what
 * `redis-cell` implements and what a leaky bucket describes. It stores one
 * number per bucket — the *theoretical arrival time*, or TAT: the moment at
 * which the bucket would next be empty if no further requests arrived.
 *
 * ```
 * emissionInterval = window / limit        // the steady rate, one request per
 * tolerance        = window                // burst allowance == a full window
 *
 * tat     = max(storedTat ?? now, now)     // a drained bucket starts from now
 * newTat  = tat + emissionInterval         // this request's cost
 * allowAt = newTat - tolerance             // when there is room for it
 *
 * if (now < allowAt)  refuse, and store nothing
 * else                allow, and store newTat
 * ```
 *
 * Three properties fall out of that, and all three are why it was chosen:
 *
 *  - **No boundary burst.** There is no window to sit on the edge of. The bucket
 *    refills continuously at `emissionInterval`, so "5 per 5 minutes" admits a
 *    burst of 5 and then one more per minute, never 10 at once.
 *  - **`Retry-After` is exact,** not a guess. `allowAt - now` *is* the time until
 *    there is room, in closed form, so the number sent to the client is the truth
 *    rather than "try again when the window rolls over".
 *  - **One number per bucket.** Cheaper than a fixed window (which needs a count
 *    and a window start to report `Reset` honestly) and far cheaper than a
 *    sliding-window log, which stores a timestamp per request.
 *
 * A refused request stores nothing, which is the other half of the shaping: a
 * caller who keeps hammering a closed bucket does not push their own recovery
 * further away. The bucket drains on the clock regardless of how hard they try.
 *
 * ## The store, and the race this does not close
 *
 * `unstorage` has no compare-and-set and no atomic increment — no `SETNX`, no
 * `INCR`, nothing atomic across its drivers. `server/utils/idempotency.ts`
 * documents the same gap at length. So {@link consumeRateLimit} is a read, a
 * decision, and a write, and two requests that interleave as read(A), read(B),
 * write(A), write(B) both see the older TAT and one of them costs the bucket
 * nothing.
 *
 * The consequence, stated plainly: **under genuinely concurrent arrivals this
 * limiter can admit more than the limit.** The overshoot is bounded by how many
 * requests fit inside one storage round trip, which is sub-millisecond on a local
 * Redis.
 *
 * Unlike idempotency, that is an acceptable trade rather than a reluctant one,
 * and the difference is worth naming. A duplicated payment is a wrong outcome no
 * amount of averaging fixes. A limiter is a statistical control: it exists to
 * bound a rate over time, a lost increment costs a fraction of one window's
 * allowance, and the next arrival reads the written TAT and is shaped normally.
 * A login limiter that admits 6 attempts instead of 5 in a dead heat still stops
 * credential stuffing; a fixed-window one that admits 10 by design does not,
 * which is the comparison that matters.
 *
 * Closing it entirely needs `ioredis` directly — a Lua script, or `INCR` plus
 * `EXPIRE` — which would give up the memory-driver test path and the no-Redis
 * deployment mode with it. `docs/rate-limiting.md` records that trade rather
 * than leaving the gap implied.
 *
 * ## Failure is open
 *
 * A store that is unreachable must not take the app down with it, so
 * `server/middleware/30.rate-limit.ts` logs and admits the request. Same stance,
 * and the same reasoning, as the session registry in `server/middleware/10.auth.ts`:
 * fail-closed would make Redis a hard dependency of *serving at all*, turning a
 * cache blip into a total outage. Fail-open costs exactly what the app had
 * before this feature existed.
 */

/** The `RateLimit-Limit` header: the policy's ceiling. */
export const RATE_LIMIT_LIMIT_HEADER = 'ratelimit-limit'

/** The `RateLimit-Remaining` header: requests left in this bucket. */
export const RATE_LIMIT_REMAINING_HEADER = 'ratelimit-remaining'

/** The `RateLimit-Reset` header: seconds until the bucket is empty again. */
export const RATE_LIMIT_RESET_HEADER = 'ratelimit-reset'

/**
 * The `RateLimit-Policy` header: the limit in `<limit>;w=<seconds>` form.
 *
 * Sent so a client can discover the shape of the limit from an ordinary
 * response, rather than having to hit it once to find out.
 */
export const RATE_LIMIT_POLICY_HEADER = 'ratelimit-policy'

/**
 * `Retry-After`, from RFC 9110 — the only one of these that is actually
 * standardised, and the only one worth relying on in a client.
 *
 * The `RateLimit-*` triple above is the shape from `draft-05` of
 * `draft-ietf-httpapi-ratelimit-headers`, which is what is widely deployed and
 * what every HTTP client library that understands rate limiting at all looks
 * for. Later drafts replace the triple with a single structured `RateLimit`
 * field; that is deliberately not emitted here, because no client reads it yet
 * and a header nothing consumes is a header that goes stale without anyone
 * noticing. See `docs/rate-limiting.md`.
 */
export const RETRY_AFTER_HEADER = 'retry-after'

/** `data.code` on every 429, so a client can tell this from any other refusal. */
export const RATE_LIMIT_ERROR_CODE = 'RATE_LIMITED'

/** Limits below this cannot express a rate; above it, the limit is not one. */
export const MIN_LIMIT = 1
export const MAX_LIMIT = 1_000_000

/**
 * Window bounds. The floor is one second — below that the emission interval is
 * shorter than the clock resolution the decision is made on.
 */
export const MIN_WINDOW_SECONDS = 1
export const MAX_WINDOW_SECONDS = 60 * 60 * 24

/**
 * How many proxy hops to trust in `x-forwarded-for`. Zero means "trust none",
 * i.e. use the socket address. See {@link resolveRateLimitSettings}.
 */
export const DEFAULT_TRUST_PROXY_HOPS = 0

/** More than this many hops is a misconfiguration, not a deployment. */
export const MAX_TRUST_PROXY_HOPS = 8

/** A limit, and the window it applies over. */
export interface RateLimitPolicy {
  /** Requests admitted per window, and the size of the burst allowance. */
  readonly limit: number
  readonly windowSeconds: number
}

/** What one arrival at one bucket resolved to. */
export interface RateLimitDecision {
  readonly allowed: boolean
  /** Echoed from the policy, so a caller building headers needs only this. */
  readonly limit: number
  readonly windowSeconds: number
  /** Requests left before the bucket closes. Zero on a refusal. */
  readonly remaining: number
  /** Seconds until the bucket is empty again — the `RateLimit-Reset` value. */
  readonly resetSeconds: number
  /** Seconds until there is room for this request. Zero when it was admitted. */
  readonly retryAfterSeconds: number
}

/** The stored bucket: one timestamp, and nothing else. */
export interface RateLimitRecord {
  /**
   * The theoretical arrival time, in epoch milliseconds — the moment this bucket
   * would next be empty. See the GCRA note above.
   */
  readonly tat: number
}

export interface RateLimitSettings {
  /** `false` turns the middleware off entirely, before any store access. */
  readonly enabled: boolean
  /** Trusted `x-forwarded-for` hops; see {@link resolveRateLimitSettings}. */
  readonly trustProxyHops: number
}

/**
 * The subset of `useRuntimeConfig()` this feature reads, declared structurally so
 * a test can pass a literal instead of a whole Nuxt config.
 *
 * The `| string` is not defensive noise — see the identical note in
 * `server/utils/storage.ts`. A `runtimeConfig` value overridden by a `NUXT_*`
 * environment variable arrives as a string, and a hop count of `"1"` used in
 * arithmetic is not a hop count.
 */
export interface RateLimitRuntimeConfig {
  readonly rateLimit?: {
    readonly enabled?: boolean | string
    readonly trustProxyHops?: number | string
  }
}

/** `Storage` typed to the record this feature stores. */
export function useRateLimitStore(): Storage<RateLimitRecord> {
  return useStorage<RateLimitRecord>(RATE_LIMIT_BASE)
}

/**
 * Coerces a runtime-config boolean that may have arrived from the environment as
 * a string.
 *
 * `NUXT_RATE_LIMIT_ENABLED=false` arrives as the *string* `"false"`, which is
 * truthy. Treating it as `true` would mean an operator who tried to turn the
 * limiter off got it left on — so the string forms are recognised explicitly,
 * and anything unrecognised falls back rather than being coerced.
 */
function toBoolean(value: boolean | string | undefined, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value
  if (value === 'true') return true
  if (value === 'false') return false
  return fallback
}

/** Clamps a configured integer into `[min, max]`, or falls back. */
function clampInteger(
  value: number | string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const parsed = typeof value === 'string' ? Number(value) : value
  if (parsed === undefined || !Number.isFinite(parsed)) return fallback
  return Math.min(Math.max(Math.floor(parsed), min), max)
}

/**
 * Turns runtime config into the two settings this feature runs on.
 *
 * Out of range is clamped rather than rejected, matching
 * `resolveIdempotencySettings`: both are operational dials, and a server that
 * refuses to boot because someone typed a large number is a worse failure than
 * the one a throw would prevent.
 *
 * ## `trustProxyHops`, and why it is a count rather than a boolean
 *
 * This is the setting that decides whether the limiter can be bypassed, so it is
 * worth understanding rather than copying.
 *
 * `x-forwarded-for` is a list that each proxy **appends** to. A request that
 * reaches one load balancer having arrived with `x-forwarded-for: 1.2.3.4`
 * already set — because the *client* sent it — is forwarded as
 * `1.2.3.4, <real client ip>`. So the leftmost entry is whatever the client
 * claimed, and the rightmost entries are the ones infrastructure you control
 * wrote.
 *
 * This is exactly the trap in h3's own `getRequestIP(event, { xForwardedFor: true })`,
 * which takes `.split(',').shift()` — the leftmost, client-controlled entry. Key
 * a limiter on that and any caller can mint an unlimited supply of fresh buckets
 * by varying one header. That is why this module counts from the right instead,
 * and why it does not use that helper.
 *
 * So the setting is **how many proxies sit in front of this app**:
 *
 *  - `0` (the default) — use the socket's peer address and ignore the header
 *    entirely. Correct for `pnpm dev`, and for anything reached directly.
 *  - `1` — one load balancer. Take the last entry, which that balancer wrote.
 *  - `2` — a CDN in front of a load balancer. Take the second from last.
 *
 * The default is 0 because it is the only value that is never *wrong*: it cannot
 * be spoofed. It can be unhelpful — behind a proxy, every caller shares the
 * proxy's address and therefore one bucket — which is why
 * `server/middleware/30.rate-limit.ts` warns once per process when a built server
 * runs with it unset. An operator who has to be told to count their hops gets a
 * limiter that is too strict and a log line explaining it; an operator who is
 * silently given the client's own header gets a limiter that does nothing.
 */
export function resolveRateLimitSettings(config: RateLimitRuntimeConfig): RateLimitSettings {
  return {
    enabled: toBoolean(config.rateLimit?.enabled, true),
    trustProxyHops: clampInteger(
      config.rateLimit?.trustProxyHops,
      DEFAULT_TRUST_PROXY_HOPS,
      0,
      MAX_TRUST_PROXY_HOPS,
    ),
  }
}

/** Clamps a table entry, so a typo in the policy table cannot disable a limit. */
export function clampPolicy(policy: RateLimitPolicy): RateLimitPolicy {
  return {
    limit: clampInteger(policy.limit, MIN_LIMIT, MIN_LIMIT, MAX_LIMIT),
    windowSeconds: clampInteger(
      policy.windowSeconds,
      MIN_WINDOW_SECONDS,
      MIN_WINDOW_SECONDS,
      MAX_WINDOW_SECONDS,
    ),
  }
}

export interface DecideInput {
  /** The stored TAT, or `undefined` for a bucket that has never been used. */
  readonly record: RateLimitRecord | undefined | null
  readonly policy: RateLimitPolicy
  /** Injected so tests do not depend on the wall clock. */
  readonly now: number
}

/** A decision, plus the TAT to persist — `null` when nothing should be written. */
export interface DecisionWithWrite {
  readonly decision: RateLimitDecision
  readonly tat: number | null
}

/**
 * The GCRA step: pure, synchronous, and the whole of the algorithm.
 *
 * Separated from {@link consumeRateLimit} so every case — a cold bucket, a
 * bucket mid-drain, a bucket exactly at its limit, a stored TAT from the past,
 * a clock that went backwards — is a table-driven unit test against literals
 * rather than something that needs a store to exercise.
 */
export function decideRateLimit(input: DecideInput): DecisionWithWrite {
  const policy = clampPolicy(input.policy)
  const windowMs = policy.windowSeconds * 1000
  const emissionIntervalMs = windowMs / policy.limit
  // Burst tolerance is one full window, which is what makes the burst allowance
  // equal to `limit`: a cold bucket admits `limit` requests back to back and
  // then one per emission interval.
  const toleranceMs = windowMs

  // `max(…, now)` is what drains an idle bucket. A stored TAT in the past
  // describes a bucket that has already emptied, and it is also what a clock
  // that jumped backwards looks like — both want the same handling, which is to
  // start counting from now rather than to credit the caller for the gap.
  const tat = Math.max(input.record?.tat ?? input.now, input.now)
  const newTat = tat + emissionIntervalMs
  const allowAtMs = newTat - toleranceMs

  if (input.now < allowAtMs) {
    return {
      // Nothing is written. A caller hammering a closed bucket does not push
      // their own recovery further out — see the module note.
      tat: null,
      decision: {
        allowed: false,
        limit: policy.limit,
        windowSeconds: policy.windowSeconds,
        remaining: 0,
        // The *existing* TAT, not `newTat`: the bucket empties when the requests
        // already counted have drained, and this one was not counted.
        resetSeconds: Math.ceil((tat - input.now) / 1000),
        // Rounded up, so a client that waits exactly this long finds room. A
        // sub-second wait still reports 1 rather than 0, because `Retry-After: 0`
        // reads as "immediately" and would put the client straight into a
        // second refusal.
        retryAfterSeconds: Math.max(1, Math.ceil((allowAtMs - input.now) / 1000)),
      },
    }
  }

  return {
    tat: newTat,
    decision: {
      allowed: true,
      limit: policy.limit,
      windowSeconds: policy.windowSeconds,
      // How many more emission intervals fit in the remaining tolerance. Floored
      // because a partial interval is not a request the caller may make.
      remaining: Math.max(0, Math.floor((toleranceMs - (newTat - input.now)) / emissionIntervalMs)),
      resetSeconds: Math.ceil((newTat - input.now) / 1000),
      retryAfterSeconds: 0,
    },
  }
}

export interface ConsumeInput {
  /** Storage key from `rateLimitStoreKey`. */
  readonly key: string
  readonly policy: RateLimitPolicy
  readonly now: number
}

/**
 * Reads a bucket, decides, and writes the new TAT when the request is admitted.
 *
 * The read-decide-write is not atomic; see the module note on exactly what that
 * does and does not guarantee. There is deliberately no read-back of the kind
 * `claimIdempotency` does: a read-back there turns a lost race into a *correct*
 * answer (409), whereas here it would only turn one lost increment into two
 * storage round trips on the hot path of every API request, and still not make
 * the pair atomic.
 *
 * Errors are not caught here. The caller decides what an unreachable store
 * means, and for this feature that decision — fail open — belongs in the
 * middleware where it can be logged once with the request in hand.
 */
export async function consumeRateLimit(
  store: Storage<RateLimitRecord>,
  input: ConsumeInput,
): Promise<RateLimitDecision> {
  const record = await store.getItem(input.key)
  const { decision, tat } = decideRateLimit({ record, policy: input.policy, now: input.now })

  if (tat !== null) {
    // The TTL is the bucket's own drain time, so a bucket that has emptied is
    // reclaimed by the driver rather than by a sweep. Floored at one second
    // because a TTL of zero means "no expiry" to the Redis driver, which would
    // leak a key per identity forever.
    //
    // Only the Redis driver honours it. The built-in memory and fs drivers
    // ignore `ttl` entirely, so on a no-Redis deployment these keys accumulate
    // for the life of the process — harmless for correctness, since a TAT in the
    // past reads as a drained bucket, but it is why `docs/rate-limiting.md` lists
    // Redis as the configuration this feature is meant to run on.
    await store.setItem(input.key, { tat }, { ttl: Math.max(1, decision.resetSeconds) })
  }

  return decision
}

/**
 * The `RateLimit-*` header values for a decision, as a plain object.
 *
 * A function of the decision alone, so what goes on the wire is unit-testable
 * without an `H3Event`. `Retry-After` is included only on a refusal: on a 200 it
 * would be meaningless, and some clients treat its mere presence as a signal to
 * back off.
 */
export function rateLimitHeaders(decision: RateLimitDecision): Record<string, string> {
  const headers: Record<string, string> = {
    [RATE_LIMIT_LIMIT_HEADER]: String(decision.limit),
    [RATE_LIMIT_REMAINING_HEADER]: String(decision.remaining),
    [RATE_LIMIT_RESET_HEADER]: String(decision.resetSeconds),
    [RATE_LIMIT_POLICY_HEADER]: `${decision.limit};w=${decision.windowSeconds}`,
  }

  if (!decision.allowed) {
    headers[RETRY_AFTER_HEADER] = String(decision.retryAfterSeconds)
  }

  return headers
}
