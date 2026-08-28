import { describe, it, expect } from 'vitest'

import {
  CACHE_BASE,
  SESSIONS_BASE,
  assertRedisUrl,
  resolveStorageMounts,
  storageBootWarning,
  toTtlSeconds,
  type StorageRuntimeConfig,
} from '~/server/utils/storage'

const REDIS_URL = 'redis://localhost:6379'

function config(overrides: StorageRuntimeConfig = {}): StorageRuntimeConfig {
  return { session: { maxAge: 604800 }, ...overrides }
}

describe('toTtlSeconds', () => {
  it('takes a number through unchanged', () => {
    expect(toTtlSeconds(300, 0)).toBe(300)
  })

  it('parses the string an NUXT_* environment override arrives as', () => {
    // The failure this prevents: `NUXT_REDIS_CACHE_TTL=300` reaching ioredis as
    // the string "300", which is not a TTL it can use.
    expect(toTtlSeconds('300', 0)).toBe(300)
  })

  it('floors a fractional value, because Redis expiry is whole seconds', () => {
    expect(toTtlSeconds(1.9, 0)).toBe(1)
  })

  it.each([
    ['undefined', undefined],
    ['an empty string', ''],
    ['a non-numeric string', 'soon'],
    ['zero', 0],
    ['a negative', -60],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
  ])('falls back on %s rather than passing it on as "never expires"', (_label, value) => {
    expect(toTtlSeconds(value, 42)).toBe(42)
  })
})

describe('assertRedisUrl', () => {
  it.each([
    'redis://localhost:6379',
    'rediss://cache.internal:6380',
    'redis://user:pw@10.0.0.4:6379/2',
  ])('accepts %s', (url) => {
    expect(() => assertRedisUrl(url)).not.toThrow()
  })

  it('rejects a URL that is not a Redis scheme', () => {
    expect(() => assertRedisUrl('postgresql://localhost:5432/db')).toThrow(/not a Redis scheme/)
  })

  it('rejects a bare host:port, the most likely thing to be pasted in by hand', () => {
    // `localhost:6379` is a valid URL — `WHATWG` reads `localhost:` as the
    // protocol — so it fails on the scheme check, not the parse. Asserting the
    // outcome rather than the branch is the point.
    expect(() => assertRedisUrl('localhost:6379')).toThrow(/not a Redis scheme/)
  })

  it('rejects something that does not parse as a URL at all', () => {
    expect(() => assertRedisUrl('redis://[unclosed')).toThrow(/not a URL/)
  })

  it('rejects a URL with no host', () => {
    expect(() => assertRedisUrl('redis:///2')).toThrow(/no host/)
  })

  it('never echoes the URL, because it carries the password', () => {
    // A boot error goes to the logs. `NUXT_REDIS_URL=https://user:hunter2@host`
    // must not put `hunter2` there.
    expect(() => assertRedisUrl('https://user:hunter2@host')).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining('hunter2') }),
    )
  })
})

describe('resolveStorageMounts', () => {
  it('mounts nothing and defaults both bases when no URL is configured', () => {
    const plan = resolveStorageMounts(config())

    expect(plan.redisMounts).toEqual([])
    expect(plan.defaultedBases).toEqual([CACHE_BASE, SESSIONS_BASE])
  })

  it('treats a whitespace-only URL as unset', () => {
    // `NUXT_REDIS_URL=` in a compose file or a Kubernetes env block is a common
    // way to say "not configured"; it must not reach the URL parser.
    expect(resolveStorageMounts(config({ redis: { url: '   ' } })).redisMounts).toEqual([])
  })

  it('mounts both bases when a URL is configured', () => {
    const plan = resolveStorageMounts(config({ redis: { url: REDIS_URL } }))

    expect(plan.redisMounts.map((mount) => mount.base)).toEqual([CACHE_BASE, SESSIONS_BASE])
    expect(plan.defaultedBases).toEqual([])
  })

  it('keeps the two bases in separate key namespaces so they can share a database', () => {
    const plan = resolveStorageMounts(config({ redis: { url: REDIS_URL } }))
    const prefixes = plan.redisMounts.map((mount) => mount.options.base)

    expect(prefixes).toEqual(['nuxt:cache', 'nuxt:sessions'])
    expect(new Set(prefixes).size).toBe(2)
  })

  it('honours a configured key prefix, so two apps can share one Redis', () => {
    const plan = resolveStorageMounts(config({ redis: { url: REDIS_URL, keyPrefix: 'staging' } }))

    expect(plan.redisMounts.map((mount) => mount.options.base)).toEqual([
      'staging:cache',
      'staging:sessions',
    ])
  })

  it('falls back to the default prefix when the configured one is blank', () => {
    const plan = resolveStorageMounts(config({ redis: { url: REDIS_URL, keyPrefix: '  ' } }))

    expect(plan.redisMounts[0]?.options.base).toBe('nuxt:cache')
  })

  it('gives the sessions mount the session cookie lifetime as its TTL', () => {
    // A record must not outlive the cookie it describes.
    const plan = resolveStorageMounts(config({ redis: { url: REDIS_URL } }))
    const sessions = plan.redisMounts.find((mount) => mount.base === SESSIONS_BASE)

    expect(sessions?.options.ttl).toBe(604800)
  })

  it('coerces a session maxAge that arrived from the environment as a string', () => {
    const plan = resolveStorageMounts({ redis: { url: REDIS_URL }, session: { maxAge: '3600' } })
    const sessions = plan.redisMounts.find((mount) => mount.base === SESSIONS_BASE)

    expect(sessions?.options.ttl).toBe(3600)
  })

  it('gives sessions a bounded TTL even with no session config at all', () => {
    const plan = resolveStorageMounts({ redis: { url: REDIS_URL } })
    const sessions = plan.redisMounts.find((mount) => mount.base === SESSIONS_BASE)

    // Never `undefined`: a session record with no expiry is a leak, and on the
    // Redis driver an absent TTL means the key is kept forever.
    expect(sessions?.options.ttl).toBeGreaterThan(0)
  })

  it('leaves the cache mount without a driver TTL by default', () => {
    // Nitro prunes its own cache entries by the `maxAge` stored inside them. A
    // driver-level expiry would be a second, shorter clock it does not know about.
    const plan = resolveStorageMounts(config({ redis: { url: REDIS_URL } }))
    const cache = plan.redisMounts.find((mount) => mount.base === CACHE_BASE)

    expect(cache?.options.ttl).toBeUndefined()
  })

  it('applies a configured cache ceiling when an operator asks for one', () => {
    const plan = resolveStorageMounts(config({ redis: { url: REDIS_URL, cacheTtlSeconds: 900 } }))
    const cache = plan.redisMounts.find((mount) => mount.base === CACHE_BASE)

    expect(cache?.options.ttl).toBe(900)
  })

  it('passes the URL through to every mount unmodified', () => {
    const url = 'rediss://user:pw@cache.internal:6380/3'
    const plan = resolveStorageMounts(config({ redis: { url } }))

    expect(plan.redisMounts.every((mount) => mount.options.url === url)).toBe(true)
  })

  it('throws on a configured-but-invalid URL instead of quietly using memory', () => {
    // The failure this prevents is the dangerous one: a server that boots, works
    // in staging, and silently splits its cache and session registry per
    // instance in production because the URL was wrong.
    expect(() => resolveStorageMounts(config({ redis: { url: 'not-a-url' } }))).toThrow(
      /NUXT_REDIS_URL/,
    )
  })
})

describe('storageBootWarning', () => {
  it('says nothing when Redis is mounted', () => {
    const plan = resolveStorageMounts(config({ redis: { url: REDIS_URL } }))

    expect(storageBootWarning(plan, false)).toBeNull()
    expect(storageBootWarning(plan, true)).toBeNull()
  })

  it('says nothing in dev, where per-process storage is the intended setup', () => {
    expect(storageBootWarning(resolveStorageMounts(config()), true)).toBeNull()
  })

  it('warns a built server that its cache and sessions are per-process', () => {
    const warning = storageBootWarning(resolveStorageMounts(config()), false)

    expect(warning).toContain('NUXT_REDIS_URL')
    expect(warning).toContain(CACHE_BASE)
    expect(warning).toContain(SESSIONS_BASE)
  })
})
