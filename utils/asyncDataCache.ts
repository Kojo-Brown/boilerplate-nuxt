/**
 * Cache keys and the TTL store behind `useCachedAsyncData`.
 *
 * Nothing here imports Nuxt. A cache key is a pure function of the request it
 * describes, and the store is a plain object hung off a host — which is what
 * lets both be unit-tested without a running app, and what keeps the store
 * per-request on the server (the host is the NuxtApp, and Nuxt builds one of
 * those per render). See `docs/async-data-caching.md`.
 */

/** A parameter value that can appear in a query string as-is. */
export type CacheKeyScalar = string | number | boolean

/**
 * The parameters that make two calls to the same endpoint different requests.
 *
 * `undefined` means "not sent" — the same meaning `$fetch` gives it, and the
 * reason `useApi()` spreads its `params` conditionally. `null` is deliberately
 * absent: a key has to say whether a filter was applied, and `null` is read as
 * "no filter" in some codebases and as a literal `?author=null` in others.
 * Omitting the parameter says the first unambiguously.
 */
export type CacheKeyParams = Readonly<
  Record<string, CacheKeyScalar | readonly CacheKeyScalar[] | undefined>
>

/**
 * Characters that structure a key. All three are escaped inside every segment,
 * so no namespace, parameter name, or value can smuggle one in and be read back
 * as structure.
 */
const PARAMS_SEPARATOR = '?'
const PAIR_SEPARATOR = '&'
const VALUE_SEPARATOR = '='
const LIST_SEPARATOR = ','

/**
 * `encodeURIComponent` escapes every character used above and is invertible, so
 * encoding each segment before joining them makes the whole key injective:
 * `key(a) === key(b)` implies `a` and `b` had the same parts, not merely parts
 * that concatenate the same way. Without it `{ 'a&b': '1' }` and
 * `{ a: '', b: '1' }` would collide, and two unrelated requests would share one
 * `useAsyncData` entry — the failure this factory exists to prevent.
 */
function encodeSegment(value: string): string {
  return encodeURIComponent(value)
}

function encodeScalar(name: string, value: CacheKeyScalar): string {
  if (typeof value === 'number' && !Number.isFinite(value)) {
    // `Number(query.page)` on a missing or malformed parameter is `NaN`, and
    // `String(NaN)` is a perfectly good-looking key segment. Caching under it
    // means every malformed request shares one entry, so this is a throw rather
    // than a coercion.
    throw new TypeError(
      `Cache key parameter "${name}" is ${String(value)}, which does not describe a request. ` +
        `Validate the value before it reaches the key.`,
    )
  }
  return encodeSegment(String(value))
}

/**
 * Builds a `useAsyncData` key from an endpoint name and the parameters that
 * vary the response.
 *
 * The contract is request equivalence: **two calls produce the same key exactly
 * when they would produce the same request.** That is why an `undefined` value
 * and an empty array are both dropped rather than encoded — neither one puts
 * anything on the wire — and why `1` and `'1'` are the same key, since a query
 * string carries no types. It is also why parameters are sorted: argument order
 * is not part of the request.
 *
 * ```ts
 * asyncDataKey('posts', { page: 2, limit: 10 }) // 'posts?limit=10&page=2'
 * asyncDataKey('posts', { limit: 10, page: 2 }) // same key
 * asyncDataKey('posts', { page: 2, author: undefined }) // 'posts?page=2'
 * ```
 *
 * @throws {TypeError} on an empty namespace, a non-finite number, or a value
 * that is not a scalar or an array of scalars — each of which would otherwise
 * produce a key that two different requests could share.
 */
export function asyncDataKey(namespace: string, params?: CacheKeyParams): string {
  if (namespace === '') {
    throw new TypeError(
      'A cache key needs a namespace: it is what separates one endpoint’s keys from another’s.',
    )
  }

  const encodedNamespace = encodeSegment(namespace)
  if (params === undefined) return encodedNamespace

  const pairs: string[] = []

  for (const [name, value] of Object.entries(params)) {
    if (value === undefined) continue

    if (Array.isArray(value)) {
      // An empty array adds nothing to a query string, so it adds nothing here.
      if (value.length === 0) continue
      const encodedItems = value.map((item) => {
        assertScalar(name, item)
        return encodeScalar(name, item)
      })
      pairs.push(`${encodeSegment(name)}${VALUE_SEPARATOR}${encodedItems.join(LIST_SEPARATOR)}`)
      continue
    }

    assertScalar(name, value)
    pairs.push(`${encodeSegment(name)}${VALUE_SEPARATOR}${encodeScalar(name, value)}`)
  }

  if (pairs.length === 0) return encodedNamespace

  // Sorted on the *encoded* name so the order depends only on the key text and
  // not on the runtime's collation. `sort()` without a comparator is already
  // code-unit order; it is spelled out because the default is easy to misread
  // as `localeCompare`.
  pairs.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))

  return `${encodedNamespace}${PARAMS_SEPARATOR}${pairs.join(PAIR_SEPARATOR)}`
}

function assertScalar(name: string, value: unknown): asserts value is CacheKeyScalar {
  const type = typeof value
  if (type === 'string' || type === 'number' || type === 'boolean') return
  throw new TypeError(
    `Cache key parameter "${name}" is ${value === null ? 'null' : type}. ` +
      `A key may only contain strings, numbers, booleans, or arrays of those — ` +
      `anything else has no single query-string form, so two different requests could share one key.`,
  )
}

/** One stored response, with what the store needs to expire and rank it. */
export interface CacheEntry<T = unknown> {
  readonly value: T
  /** `Date.now()` at the moment the value was written. */
  readonly storedAt: number
  /**
   * Serialized size of `value` in bytes, or `null` when it could not be
   * measured. See `measurePayloadBytes` in `utils/payloadBudget.ts`.
   */
  readonly bytes: number | null
}

/** Why a read did not return a value. */
export type CacheMissReason = 'miss' | 'expired'

export type CacheRead<T> =
  | { readonly hit: true; readonly entry: CacheEntry<T> }
  | { readonly hit: false; readonly reason: CacheMissReason }

export interface AsyncDataCacheOptions {
  /**
   * How long an entry may be served, in milliseconds. Clamped to a minimum of
   * 0; a TTL of 0 expires an entry immediately, which turns the cache off
   * without changing any call site.
   */
  readonly ttlMs: number
  /**
   * The most entries the store may hold. Reached, the oldest write is dropped.
   *
   * This cap is not a nicety. Supplying `getCachedData` to `useAsyncData` turns
   * off Nuxt's own `purgeCachedData` sweep for that key (it only purges keys
   * that kept the default), so from the moment this composable is used, nothing
   * but this cap bounds what the app holds.
   */
  readonly maxEntries: number
}

export const DEFAULT_CACHE_TTL_MS = 30_000
export const DEFAULT_CACHE_MAX_ENTRIES = 50

/**
 * The object a store is attached to. Structurally satisfied by `NuxtApp`, which
 * `useCachedAsyncData` augments with the same optional property — so the
 * composable can pass `useNuxtApp()` straight in with no cast, and a test can
 * pass `{}`.
 */
export interface CacheHost {
  _cachedAsyncData?: AsyncDataCache
}

export interface AsyncDataCacheSnapshot {
  readonly key: string
  readonly storedAt: number
  readonly bytes: number | null
  readonly ageMs: number
  readonly expired: boolean
}

/**
 * A bounded TTL map. Not reactive and not serialized: it holds what was already
 * fetched so a remount can skip re-fetching it, and nothing else depends on it
 * having a particular value at a particular time.
 */
export class AsyncDataCache {
  readonly #entries = new Map<string, CacheEntry>()
  #ttlMs: number
  #maxEntries: number

  constructor(options: Partial<AsyncDataCacheOptions> = {}) {
    this.#ttlMs = Math.max(0, options.ttlMs ?? DEFAULT_CACHE_TTL_MS)
    this.#maxEntries = Math.max(1, Math.trunc(options.maxEntries ?? DEFAULT_CACHE_MAX_ENTRIES))
  }

  get ttlMs(): number {
    return this.#ttlMs
  }

  get maxEntries(): number {
    return this.#maxEntries
  }

  get size(): number {
    return this.#entries.size
  }

  /**
   * Raises the limits if a later caller asks for more than the first one did.
   *
   * One store serves every key in a Nuxt app, so its limits are settled by
   * whichever composable happened to run first. Taking the larger of the two
   * means a call site that asked for a 5-minute TTL still gets one after a
   * 10-second call site created the store, instead of silently getting 10
   * seconds. Per-key TTLs are the alternative and are not worth the bookkeeping
   * here; `docs/async-data-caching.md` says so where a reader will look.
   */
  widen(options: Partial<AsyncDataCacheOptions>): void {
    if (options.ttlMs !== undefined) this.#ttlMs = Math.max(this.#ttlMs, Math.max(0, options.ttlMs))
    if (options.maxEntries !== undefined) {
      this.#maxEntries = Math.max(this.#maxEntries, Math.max(1, Math.trunc(options.maxEntries)))
    }
  }

  /**
   * Reads an entry, dropping it if it has aged out.
   *
   * The cast is the one place the store's heterogeneity meets a caller's type.
   * A store holds every key in the app, so it cannot be generic; a key is
   * expected to hold one shape, which is the same contract `useAsyncData`
   * already has for its own key.
   */
  read<T>(key: string, now: number): CacheRead<T> {
    const entry = this.#entries.get(key)
    if (entry === undefined) return { hit: false, reason: 'miss' }

    if (this.#isExpired(entry, now)) {
      this.#entries.delete(key)
      return { hit: false, reason: 'expired' }
    }

    return { hit: true, entry: entry as CacheEntry<T> }
  }

  /** Stores a value, evicting anything expired and then the oldest write. */
  write<T>(key: string, value: T, now: number, bytes: number | null = null): CacheEntry<T> {
    const entry: CacheEntry<T> = { value, storedAt: now, bytes }

    // Delete first so a re-write moves the key to the end of the Map's
    // insertion order; `#evict` reads that order as "oldest first".
    this.#entries.delete(key)
    this.#entries.set(key, entry)
    this.#evict(now)

    return entry
  }

  /** Drops one key, or the whole store when called with no key. */
  invalidate(key?: string): void {
    if (key === undefined) {
      this.#entries.clear()
      return
    }
    this.#entries.delete(key)
  }

  /** What the store holds right now — for the demo page and for tests. */
  snapshot(now: number): readonly AsyncDataCacheSnapshot[] {
    return [...this.#entries].map(([key, entry]) => ({
      key,
      storedAt: entry.storedAt,
      bytes: entry.bytes,
      ageMs: now - entry.storedAt,
      expired: this.#isExpired(entry, now),
    }))
  }

  #isExpired(entry: CacheEntry, now: number): boolean {
    // `>=` rather than `>`: with a TTL of 0 an entry is expired the moment it is
    // written, which is what "no caching" has to mean for the option to be
    // usable as an off switch.
    return now - entry.storedAt >= this.#ttlMs
  }

  #evict(now: number): void {
    for (const [key, entry] of this.#entries) {
      if (this.#isExpired(entry, now)) this.#entries.delete(key)
    }

    // Map iterates in insertion order, so the first key is the oldest write.
    while (this.#entries.size > this.#maxEntries) {
      const oldest = this.#entries.keys().next()
      if (oldest.done === true) break
      this.#entries.delete(oldest.value)
    }
  }
}

/**
 * The store attached to `host`, created on first use.
 *
 * Attaching it to the host rather than holding it at module scope is the whole
 * SSR-safety argument from `docs/composable-design-rules.md`: a module is
 * evaluated once per server *process*, so a module-scope `Map` would serve one
 * visitor's responses to the next. The NuxtApp is per-request, so this one
 * cannot.
 */
export function asyncDataCacheFor(
  host: CacheHost,
  options: Partial<AsyncDataCacheOptions> = {},
): AsyncDataCache {
  const existing = host._cachedAsyncData
  if (existing !== undefined) {
    existing.widen(options)
    return existing
  }

  const created = new AsyncDataCache(options)
  host._cachedAsyncData = created
  return created
}
