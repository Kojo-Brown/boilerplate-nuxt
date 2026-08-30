/**
 * The Nitro storage layer — which key-value bases exist, and what backs them.
 *
 * Nitro gives every server process one `unstorage` instance, reachable as
 * `useStorage()`, with named *bases* mounted onto it. Two of those bases matter
 * to this app:
 *
 * - **`cache`** is mostly not ours. Nitro writes there itself: the `swr` and
 *   `isr` route rules added in `route-rules.config.ts` store their cached
 *   payloads under `cache:`, and so do the `defineCachedEventHandler` routes in
 *   `server/api/cached/`. Mounting Redis on it is the whole point — until then,
 *   "cached for 60 seconds" meant *per process*, so a two-instance deployment
 *   had two independent caches and a client could see a 60-second-old page and a
 *   fresh one alternately. The one thing this app writes there itself is the
 *   cache-tag index (`server/utils/cache-tags.ts`), which is metadata about
 *   those entries and is meant to be discarded with them.
 * - **`sessions`** is ours, and is the session registry described in
 *   `server/utils/session-store.ts`.
 *
 * ## Why this is mounted at runtime and not in `nuxt.config.ts`
 *
 * Nitro takes a `storage` key in `nuxt.config.ts`, and that is the usual way to
 * mount a driver. It is the wrong way here. That config is **serialised into
 * the build**, so a Redis URL written there — or read there from `process.env`,
 * which is the same mistake with extra steps — is baked into `.output/` and
 * ships with it. `nuxt.config.ts` already carries the note: never read
 * `process.env` there.
 *
 * So the URL lives in `runtimeConfig` like every other credential in this
 * project (`NUXT_REDIS_URL` at runtime), and `server/plugins/storage.ts` mounts
 * the driver during Nitro startup, before the first request. One image, any
 * Redis.
 *
 * ## Unconfigured is a supported mode; misconfigured is not
 *
 * With no `NUXT_REDIS_URL`, nothing is mounted and both bases keep whatever
 * Nitro gave them — an fs directory under `.nuxt/` in dev, memory in a built
 * server. That is correct for `pnpm dev`, for `pnpm test`, and for a single
 * instance, and it is why the app boots with no Redis at all.
 *
 * A URL that is set but unusable is the opposite: it means someone intended
 * shared storage and will not get it. Falling back to memory there would hand
 * them a server that boots, works in staging, and silently splits its cache and
 * its session registry per instance in production. {@link resolveStorageMounts}
 * throws instead.
 */

/** The bases this app mounts. Nitro owns `cache`; `sessions` is ours. */
export const CACHE_BASE = 'cache'
export const SESSIONS_BASE = 'sessions'

export type StorageBase = typeof CACHE_BASE | typeof SESSIONS_BASE

/** Redis URL schemes `ioredis` understands. `rediss:` is TLS. */
const REDIS_PROTOCOLS = new Set(['redis:', 'rediss:'])

/** A day, in seconds — the fallback session lifetime if config carries none. */
const DEFAULT_SESSION_TTL_SECONDS = 60 * 60 * 24

/**
 * The subset of `useRuntimeConfig()` this module reads, declared structurally so
 * a test can pass a literal instead of a whole Nuxt config.
 *
 * The `string` in the numeric unions is not defensive noise: `runtimeConfig`
 * values overridden by `NUXT_*` environment variables arrive as strings unless
 * Nuxt's own coercion recognises the default's type, and a `NUXT_REDIS_CACHE_TTL`
 * that stayed `"300"` would be handed to `ioredis` as a TTL it cannot use.
 */
export interface StorageRuntimeConfig {
  readonly redis?: {
    readonly url?: string
    readonly keyPrefix?: string
    readonly cacheTtlSeconds?: number | string
  }
  readonly session?: {
    readonly maxAge?: number | string
  }
}

/**
 * Options for `unstorage/drivers/redis`, narrowed to what this app sets.
 *
 * Declared here rather than imported from the driver so that this module — the
 * one with all the decisions in it — stays importable in a plain Node test
 * without pulling in `ioredis`. It is structurally assignable to the driver's
 * own `RedisOptions`, which is what `server/plugins/storage.ts` checks by
 * passing it straight through.
 */
export interface RedisMountOptions {
  /** `redis://` or `rediss://`. Never logged — it carries the password. */
  readonly url: string
  /** Key prefix, so both bases can share one Redis database. */
  readonly base: string
  /** Default expiry for keys written to this base, in seconds. */
  readonly ttl?: number
}

export interface RedisMount {
  readonly base: StorageBase
  readonly options: RedisMountOptions
}

export interface StorageMountPlan {
  /** Bases to mount on Redis. Empty when `NUXT_REDIS_URL` is unset. */
  readonly redisMounts: readonly RedisMount[]
  /** Bases left on whatever Nitro mounted for them. */
  readonly defaultedBases: readonly StorageBase[]
}

/**
 * Coerces a runtime-config number that may have arrived from the environment as
 * a string. Anything that is not a finite, positive integer count of seconds —
 * `""`, `"0"`, `"abc"`, a negative — falls back, because a TTL of zero or NaN is
 * accepted by `ioredis` as "no expiry" and would leak session records forever.
 */
export function toTtlSeconds(value: number | string | undefined, fallback: number): number {
  const parsed = typeof value === 'string' ? Number(value) : value
  if (parsed === undefined || !Number.isFinite(parsed) || parsed <= 0) return fallback
  return Math.floor(parsed)
}

/**
 * Validates a configured Redis URL, or throws with the reason.
 *
 * The thrown message names the environment variable rather than echoing the URL:
 * a Redis URL contains the password, and a boot error goes to the logs.
 */
export function assertRedisUrl(url: string): void {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error(
      'NUXT_REDIS_URL is not a URL. Expected redis://[user:password@]host:port[/db] ' +
        '(or rediss:// for TLS).',
    )
  }

  if (!REDIS_PROTOCOLS.has(parsed.protocol)) {
    throw new Error(
      `NUXT_REDIS_URL has protocol "${parsed.protocol}", which is not a Redis scheme. ` +
        'Expected redis:// or rediss://.',
    )
  }

  if (!parsed.hostname) {
    throw new Error('NUXT_REDIS_URL has no host.')
  }
}

/**
 * Turns runtime config into the set of Redis mounts to apply at startup.
 *
 * Throws when a Redis URL is present but unusable — see the note at the top of
 * this file on why that is fatal rather than a fallback.
 */
export function resolveStorageMounts(config: StorageRuntimeConfig): StorageMountPlan {
  const url = config.redis?.url?.trim() ?? ''

  if (url === '') {
    return { redisMounts: [], defaultedBases: [CACHE_BASE, SESSIONS_BASE] }
  }

  assertRedisUrl(url)

  const prefix = config.redis?.keyPrefix?.trim() || 'nuxt'
  const sessionTtl = toTtlSeconds(config.session?.maxAge, DEFAULT_SESSION_TTL_SECONDS)
  const cacheTtl = toTtlSeconds(config.redis?.cacheTtlSeconds, 0)

  const cacheOptions: RedisMountOptions =
    cacheTtl > 0
      ? { url, base: `${prefix}:${CACHE_BASE}`, ttl: cacheTtl }
      : { url, base: `${prefix}:${CACHE_BASE}` }

  return {
    redisMounts: [
      // No default TTL unless one is configured: Nitro's own cache entries carry
      // their `maxAge` inside the stored value and it prunes them on read, so a
      // driver-level expiry would be a second, shorter clock that Nitro does not
      // know about. `NUXT_REDIS_CACHE_TTL` exists as a backstop for operators who
      // want a hard ceiling on how long any cache key can occupy Redis.
      { base: CACHE_BASE, options: cacheOptions },
      // Session records do need one. It matches the session cookie's own
      // `maxAge`, so a record cannot outlive the cookie it describes, and an
      // abandoned session is reclaimed by Redis rather than by a cleanup job.
      {
        base: SESSIONS_BASE,
        options: { url, base: `${prefix}:${SESSIONS_BASE}`, ttl: sessionTtl },
      },
    ],
    defaultedBases: [],
  }
}

/**
 * The one line worth logging at boot, or `null` when there is nothing to say.
 *
 * Success is silent. The only message is the one case an operator needs to see:
 * a **built** server running without Redis, where `cache` and `sessions` are
 * per-process and a second instance will not share either. In dev that is the
 * intended setup, so it says nothing.
 *
 * Split out from the plugin so the decision is testable without booting Nitro.
 */
export function storageBootWarning(plan: StorageMountPlan, dev: boolean): string | null {
  if (plan.redisMounts.length > 0 || dev) return null

  return (
    `Nitro storage: ${plan.defaultedBases.join(' and ')} are on the built-in per-process ` +
    'driver because NUXT_REDIS_URL is unset. Route-rule caches and session revocation ' +
    'will not be shared between instances. See docs/nitro-storage.md.'
  )
}
