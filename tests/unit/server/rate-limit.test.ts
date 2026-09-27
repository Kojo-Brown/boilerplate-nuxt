import { describe, it, expect } from 'vitest'
import { createStorage } from 'unstorage'
import memoryDriver from 'unstorage/drivers/memory'
import type { Storage } from 'unstorage'

import {
  clampPolicy,
  consumeRateLimit,
  decideRateLimit,
  rateLimitHeaders,
  resolveRateLimitSettings,
  DEFAULT_TRUST_PROXY_HOPS,
  MAX_LIMIT,
  MAX_TRUST_PROXY_HOPS,
  MAX_WINDOW_SECONDS,
  MIN_LIMIT,
  MIN_WINDOW_SECONDS,
  RATE_LIMIT_LIMIT_HEADER,
  RATE_LIMIT_POLICY_HEADER,
  RATE_LIMIT_REMAINING_HEADER,
  RATE_LIMIT_RESET_HEADER,
  RETRY_AFTER_HEADER,
  type RateLimitPolicy,
  type RateLimitRecord,
} from '~/server/utils/rate-limit'

/**
 * The GCRA step and the store wrapper around it.
 *
 * `decideRateLimit` is pure and synchronous, so the interesting cases — a cold
 * bucket, a bucket exactly at its limit, a bucket mid-drain, a stored timestamp
 * from the past or the future — are literals rather than orchestration. The
 * store-backed tests below use the real memory driver instead of a mock, because
 * what they assert is that a sequence of arrivals shapes as documented, and a
 * fake `getItem`/`setItem` pair would only prove the calls were made.
 */

/** Five per minute: small enough that every boundary is countable by hand. */
const FIVE_PER_MINUTE: RateLimitPolicy = { limit: 5, windowSeconds: 60 }

const T0 = 1_700_000_000_000

function store(): Storage<RateLimitRecord> {
  return createStorage<RateLimitRecord>({ driver: memoryDriver() })
}

describe('decideRateLimit', () => {
  it('admits the first request to a cold bucket and reports a full burst spent once', () => {
    const { decision, tat } = decideRateLimit({
      record: undefined,
      policy: FIVE_PER_MINUTE,
      now: T0,
    })

    expect(decision.allowed).toBe(true)
    expect(decision.limit).toBe(5)
    expect(decision.windowSeconds).toBe(60)
    // One of five spent, so four left.
    expect(decision.remaining).toBe(4)
    // The bucket drains one emission interval (12s) after this arrival.
    expect(decision.resetSeconds).toBe(12)
    expect(decision.retryAfterSeconds).toBe(0)
    expect(tat).toBe(T0 + 12_000)
  })

  it('admits exactly `limit` requests arriving at the same instant, then refuses', () => {
    let record: RateLimitRecord | undefined
    const remaining: number[] = []

    for (let attempt = 0; attempt < 5; attempt++) {
      const { decision, tat } = decideRateLimit({ record, policy: FIVE_PER_MINUTE, now: T0 })
      expect(decision.allowed).toBe(true)
      remaining.push(decision.remaining)
      record = { tat: tat as number }
    }

    // The burst allowance is the limit, and it is spent one at a time.
    expect(remaining).toEqual([4, 3, 2, 1, 0])

    const sixth = decideRateLimit({ record, policy: FIVE_PER_MINUTE, now: T0 })

    expect(sixth.decision.allowed).toBe(false)
    expect(sixth.decision.remaining).toBe(0)
    // One emission interval until there is room for one more.
    expect(sixth.decision.retryAfterSeconds).toBe(12)
    // …and a full window until the bucket is empty.
    expect(sixth.decision.resetSeconds).toBe(60)
  })

  it('writes nothing for a refused request, so hammering does not defer recovery', () => {
    const full: RateLimitRecord = { tat: T0 + 60_000 }

    const first = decideRateLimit({ record: full, policy: FIVE_PER_MINUTE, now: T0 })
    const second = decideRateLimit({ record: full, policy: FIVE_PER_MINUTE, now: T0 })

    expect(first.tat).toBeNull()
    expect(second.tat).toBeNull()
    // The second refusal is no further away than the first.
    expect(second.decision.retryAfterSeconds).toBe(first.decision.retryAfterSeconds)
  })

  it('refills one request per emission interval rather than all at once', () => {
    const full: RateLimitRecord = { tat: T0 + 60_000 }

    // 12s later, exactly one interval has drained.
    const afterOne = decideRateLimit({ record: full, policy: FIVE_PER_MINUTE, now: T0 + 12_000 })
    expect(afterOne.decision.allowed).toBe(true)
    expect(afterOne.decision.remaining).toBe(0)

    // Immediately after taking it, the bucket is closed again.
    const immediately = decideRateLimit({
      record: { tat: afterOne.tat as number },
      policy: FIVE_PER_MINUTE,
      now: T0 + 12_000,
    })
    expect(immediately.decision.allowed).toBe(false)
  })

  it('has no boundary burst: a full window later the allowance is the burst, not double it', () => {
    // The property a fixed-window counter does not have. Spend the burst at T0,
    // wait one whole window, and the most that can be taken is the burst again —
    // never 2 × limit back to back across the boundary.
    let record: RateLimitRecord | undefined = { tat: T0 + 60_000 }
    let admitted = 0
    const now = T0 + 60_000

    for (let attempt = 0; attempt < 10; attempt++) {
      const { decision, tat } = decideRateLimit({ record, policy: FIVE_PER_MINUTE, now })
      if (!decision.allowed) break
      admitted++
      record = { tat: tat as number }
    }

    expect(admitted).toBe(5)
  })

  it('treats a stored timestamp in the past as a drained bucket', () => {
    const stale: RateLimitRecord = { tat: T0 - 10 * 60_000 }

    const { decision } = decideRateLimit({ record: stale, policy: FIVE_PER_MINUTE, now: T0 })

    expect(decision.allowed).toBe(true)
    expect(decision.remaining).toBe(4)
  })

  it('does not credit a caller when the clock goes backwards', () => {
    // A TAT from the future is what a backwards clock step looks like. The bucket
    // must still be read as full rather than as an enormous allowance.
    const record: RateLimitRecord = { tat: T0 + 60_000 }

    const { decision } = decideRateLimit({ record, policy: FIVE_PER_MINUTE, now: T0 - 30_000 })

    expect(decision.allowed).toBe(false)
    expect(decision.remaining).toBe(0)
  })

  it('never reports Retry-After: 0 on a refusal, which would mean "immediately"', () => {
    // A refusal with a sub-second wait. Ceiling gives 1; a floor would give 0 and
    // put a well-behaved client straight into a second 429.
    const policy: RateLimitPolicy = { limit: 1, windowSeconds: 10 }
    const record: RateLimitRecord = { tat: T0 + 10_000 }

    const { decision } = decideRateLimit({ record, policy, now: T0 + 9_500 })

    expect(decision.allowed).toBe(false)
    expect(decision.retryAfterSeconds).toBe(1)
  })

  it('treats a null record the same as a missing one', () => {
    // `getItem` resolves to `null`, not `undefined`, for a key that is not there.
    const fromNull = decideRateLimit({ record: null, policy: FIVE_PER_MINUTE, now: T0 })
    const fromUndefined = decideRateLimit({ record: undefined, policy: FIVE_PER_MINUTE, now: T0 })

    expect(fromNull).toEqual(fromUndefined)
  })

  it('clamps a policy so a table typo cannot mean "no limit"', () => {
    const { decision } = decideRateLimit({
      record: undefined,
      policy: { limit: 0, windowSeconds: 0 },
      now: T0,
    })

    expect(decision.limit).toBe(MIN_LIMIT)
    expect(decision.windowSeconds).toBe(MIN_WINDOW_SECONDS)
  })
})

describe('clampPolicy', () => {
  it('leaves a policy inside the bounds alone', () => {
    expect(clampPolicy(FIVE_PER_MINUTE)).toEqual(FIVE_PER_MINUTE)
  })

  it.each([
    { input: { limit: 0, windowSeconds: 60 }, limit: MIN_LIMIT, windowSeconds: 60 },
    { input: { limit: -5, windowSeconds: 60 }, limit: MIN_LIMIT, windowSeconds: 60 },
    { input: { limit: 5, windowSeconds: 0 }, limit: 5, windowSeconds: MIN_WINDOW_SECONDS },
    {
      input: { limit: MAX_LIMIT * 2, windowSeconds: 60 },
      limit: MAX_LIMIT,
      windowSeconds: 60,
    },
    {
      input: { limit: 5, windowSeconds: MAX_WINDOW_SECONDS * 2 },
      limit: 5,
      windowSeconds: MAX_WINDOW_SECONDS,
    },
    { input: { limit: 5.9, windowSeconds: 60.9 }, limit: 5, windowSeconds: 60 },
  ])('clamps $input', ({ input, limit, windowSeconds }) => {
    expect(clampPolicy(input)).toEqual({ limit, windowSeconds })
  })
})

describe('resolveRateLimitSettings', () => {
  it('defaults to enabled, trusting no proxy', () => {
    expect(resolveRateLimitSettings({})).toEqual({
      enabled: true,
      trustProxyHops: DEFAULT_TRUST_PROXY_HOPS,
    })
  })

  it('honours the string "false" an environment variable actually delivers', () => {
    // The case that matters: `NUXT_RATE_LIMIT_ENABLED=false` arrives as a string,
    // and a truthiness check would leave the limiter on.
    expect(resolveRateLimitSettings({ rateLimit: { enabled: 'false' } }).enabled).toBe(false)
    expect(resolveRateLimitSettings({ rateLimit: { enabled: 'true' } }).enabled).toBe(true)
  })

  it('falls back rather than coercing an unrecognised enabled value', () => {
    expect(resolveRateLimitSettings({ rateLimit: { enabled: 'yes' } }).enabled).toBe(true)
  })

  it('parses a hop count that arrived from the environment as a string', () => {
    expect(resolveRateLimitSettings({ rateLimit: { trustProxyHops: '2' } }).trustProxyHops).toBe(2)
  })

  it.each([
    { input: -1, expected: 0 },
    { input: 0, expected: 0 },
    { input: 1, expected: 1 },
    { input: MAX_TRUST_PROXY_HOPS + 5, expected: MAX_TRUST_PROXY_HOPS },
  ])('clamps a hop count of $input to $expected', ({ input, expected }) => {
    expect(resolveRateLimitSettings({ rateLimit: { trustProxyHops: input } }).trustProxyHops).toBe(
      expected,
    )
  })

  it('falls back on a hop count that is not a number', () => {
    expect(resolveRateLimitSettings({ rateLimit: { trustProxyHops: 'two' } }).trustProxyHops).toBe(
      DEFAULT_TRUST_PROXY_HOPS,
    )
  })
})

describe('consumeRateLimit', () => {
  it('shapes a burst against a real store exactly as the pure step does', async () => {
    const limiter = store()
    const outcomes: boolean[] = []

    for (let attempt = 0; attempt < 7; attempt++) {
      const decision = await consumeRateLimit(limiter, {
        key: 'rule:ip:1.2.3.4',
        policy: FIVE_PER_MINUTE,
        now: T0,
      })
      outcomes.push(decision.allowed)
    }

    expect(outcomes).toEqual([true, true, true, true, true, false, false])
  })

  it('keeps two identities in separate buckets', async () => {
    const limiter = store()

    for (let attempt = 0; attempt < 5; attempt++) {
      await consumeRateLimit(limiter, { key: 'rule:ip:1.1.1.1', policy: FIVE_PER_MINUTE, now: T0 })
    }

    const exhausted = await consumeRateLimit(limiter, {
      key: 'rule:ip:1.1.1.1',
      policy: FIVE_PER_MINUTE,
      now: T0,
    })
    const other = await consumeRateLimit(limiter, {
      key: 'rule:ip:2.2.2.2',
      policy: FIVE_PER_MINUTE,
      now: T0,
    })

    expect(exhausted.allowed).toBe(false)
    expect(other.allowed).toBe(true)
  })

  it('persists only the admitted arrivals', async () => {
    const limiter = store()
    const key = 'rule:ip:1.2.3.4'

    await consumeRateLimit(limiter, { key, policy: FIVE_PER_MINUTE, now: T0 })
    const afterFirst = await limiter.getItem(key)

    // Fill it, then refuse one, and check the refusal left the record alone.
    for (let attempt = 0; attempt < 4; attempt++) {
      await consumeRateLimit(limiter, { key, policy: FIVE_PER_MINUTE, now: T0 })
    }
    const afterBurst = await limiter.getItem(key)
    await consumeRateLimit(limiter, { key, policy: FIVE_PER_MINUTE, now: T0 })

    expect(afterFirst).toEqual({ tat: T0 + 12_000 })
    expect(await limiter.getItem(key)).toEqual(afterBurst)
  })

  it('lets a bucket recover on the clock', async () => {
    const limiter = store()
    const key = 'rule:ip:1.2.3.4'

    for (let attempt = 0; attempt < 5; attempt++) {
      await consumeRateLimit(limiter, { key, policy: FIVE_PER_MINUTE, now: T0 })
    }

    const refused = await consumeRateLimit(limiter, { key, policy: FIVE_PER_MINUTE, now: T0 })
    const recovered = await consumeRateLimit(limiter, {
      key,
      policy: FIVE_PER_MINUTE,
      now: T0 + refused.retryAfterSeconds * 1000,
    })

    expect(refused.allowed).toBe(false)
    // Waiting exactly the advertised Retry-After is enough — the number sent to
    // the client has to be true, not approximately true.
    expect(recovered.allowed).toBe(true)
  })

  it('does not swallow a store failure, so the middleware can decide', async () => {
    const broken = {
      getItem: () => Promise.reject(new Error('ECONNREFUSED')),
      setItem: () => Promise.resolve(),
    } as unknown as Storage<RateLimitRecord>

    await expect(
      consumeRateLimit(broken, { key: 'k', policy: FIVE_PER_MINUTE, now: T0 }),
    ).rejects.toThrow('ECONNREFUSED')
  })
})

describe('rateLimitHeaders', () => {
  it('reports the policy and the remaining allowance on an admitted request', () => {
    const { decision } = decideRateLimit({
      record: undefined,
      policy: FIVE_PER_MINUTE,
      now: T0,
    })

    expect(rateLimitHeaders(decision)).toEqual({
      [RATE_LIMIT_LIMIT_HEADER]: '5',
      [RATE_LIMIT_REMAINING_HEADER]: '4',
      [RATE_LIMIT_RESET_HEADER]: '12',
      [RATE_LIMIT_POLICY_HEADER]: '5;w=60',
    })
  })

  it('adds Retry-After only on a refusal', () => {
    const { decision } = decideRateLimit({
      record: { tat: T0 + 60_000 },
      policy: FIVE_PER_MINUTE,
      now: T0,
    })

    const headers = rateLimitHeaders(decision)

    expect(headers[RETRY_AFTER_HEADER]).toBe('12')
    expect(headers[RATE_LIMIT_REMAINING_HEADER]).toBe('0')
  })
})
