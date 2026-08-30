import type { H3Event } from 'h3'
import type { Storage } from 'unstorage'

import {
  CACHE_ENTRY_GROUP,
  assertCacheName,
  cacheEntryKey,
  cacheKeySuffix,
  invalidateCacheName,
  invalidateCacheTags,
  normaliseTags,
  registerCacheEntryTags,
  type CachedEntryContext,
  type TagInvalidation,
} from '~/server/utils/cache-tags'
import { CACHE_BASE } from '~/server/utils/storage'

/**
 * `defineCachedEventHandler`, wired to the tag index in
 * `server/utils/cache-tags.ts`.
 *
 * That module explains what a tag is and why the storage key has to be
 * reconstructible rather than hashed. This one is the seam where the two meet
 * Nitro: it owns the `defineCachedEventHandler` call, the `useStorage()` lookup,
 * and the decision of *when* an entry gets indexed.
 *
 * ```ts
 * export default defineCachedApiHandler(
 *   {
 *     name: 'catalog',
 *     maxAge: 30,
 *     key: (event) => [String(getQuery(event)['page'] ?? 1)],
 *     tags: ['catalog'],
 *   },
 *   async () => readCatalog(),
 * )
 * ```
 *
 * ## When tags are written
 *
 * Nitro calls the wrapped handler only when it needs a fresh value — a miss, an
 * expiry, or a background revalidation. A cache *hit* never reaches it. So the
 * index write sits inside the wrapper and costs nothing on the path that
 * matters, which is the one the cache exists to make fast.
 *
 * It happens **before** Nitro writes the entry, because there is no hook that
 * fires after. Two consequences, both real and neither hidden:
 *
 *  - An invalidation that lands in that window removes an index key for an entry
 *    written a moment later. The entry then survives until `maxAge`.
 *  - A response Nitro declines to cache — its `validate` rejects a status ≥ 400
 *    and a body-less entry — still gets index keys. They point at nothing, cost
 *    one `removeItem` on the next sweep, and expire with the rest.
 *
 * {@link invalidateCachedRoute} clears both, and is what to reach for when
 * `maxAge` is too long to wait. The alternative — a write-through wrapper that
 * stores entries itself — means not using `defineCachedEventHandler` at all, and
 * losing its SWR handling, its `etag`/`last-modified` negotiation and its
 * single-flight deduplication of concurrent misses with it. Indexing early is
 * the cheaper side of that trade.
 *
 * ## `varies` is applied here, not by Nitro
 *
 * Nitro's `varies` option normally folds the named request headers into the
 * cache key. It stops doing that the moment a custom `getKey` is supplied: its
 * wrapper returns the custom key immediately and never reaches the header
 * hashing below it. Passing `varies` and `getKey` together therefore looks
 * correct and silently serves one cached response for every value of the header
 * — an `accept-language` route answering French out of the English entry.
 *
 * Every route here has a custom key, by construction, so {@link varyKeyParts}
 * folds the headers in itself. `varies` is still passed through to Nitro,
 * because it also decides which request headers the wrapped handler can see.
 */

/** Options for {@link defineCachedApiHandler}. */
export interface CachedApiHandlerOptions {
  /**
   * Identifies the route in the storage key (`app:<name>:<key>.json`), and is
   * what {@link invalidateCachedRoute} sweeps. Lowercase letters, digits and
   * hyphens.
   */
  readonly name: string

  /** Seconds before an entry is considered stale. */
  readonly maxAge: number

  /**
   * Serve a stale entry while revalidating in the background. Default `true`,
   * matching Nitro's own default: the first request after expiry gets the old
   * copy immediately instead of waiting for a re-render.
   */
  readonly swr?: boolean

  /** With `swr`, how long a stale entry may still be served. Seconds. */
  readonly staleMaxAge?: number

  /**
   * The parts of the request that make two calls different responses — a page
   * number, a route param, a locale. Omit for a route with a single entry.
   *
   * Must be a pure function of the request: it is called once per request, and
   * an entry is only ever reachable again by producing the same parts.
   */
  readonly key?: (event: H3Event) => readonly string[]

  /**
   * Tags to attach to whatever this render produces, fixed or derived from the
   * request. ``['catalog', `catalog:${id}`]`` lets one item be invalidated
   * without dropping the list that contains it.
   */
  readonly tags: readonly string[] | ((event: H3Event) => readonly string[])

  /**
   * Request headers whose value changes the response. Folded into the key here
   * — see the note above on why Nitro will not do it for a custom key.
   */
  readonly varies?: readonly string[]
}

/** Nitro's `cache` base — where cached entries and their tag index both live. */
export function useCacheStore(): Storage {
  return useStorage(CACHE_BASE)
}

/**
 * The header values that belong in the cache key, as key parts.
 *
 * A missing header contributes an empty value rather than being skipped, so
 * "no `accept-language`" and `accept-language: ` are one entry, and neither can
 * be answered out of the other's.
 */
export function varyKeyParts(event: H3Event, varies: readonly string[]): string[] {
  return varies.map((header) => `${header.toLowerCase()}=${getRequestHeader(event, header) ?? ''}`)
}

/**
 * Resolves the cache entry one request maps to: its key, its tags, and how long
 * the index should keep it.
 *
 * Exported for the tests, which assert the two things the rest of the feature
 * rests on — that the key survives Nitro's `escapeKey` untouched, and that it is
 * the key Nitro will actually write.
 */
export function resolveCachedEntry(
  options: CachedApiHandlerOptions,
  event: H3Event,
): CachedEntryContext {
  const varies = options.varies ?? []
  const parts = [...(options.key?.(event) ?? []), ...varyKeyParts(event, varies)]
  const keySuffix = cacheKeySuffix(parts)
  const tags = typeof options.tags === 'function' ? options.tags(event) : options.tags

  return {
    keySuffix,
    entryKey: cacheEntryKey(options.name, keySuffix),
    tags: normaliseTags(tags),
    // Nitro gives a stored entry a TTL only when it is not serving stale copies
    // (`opts.maxAge && !opts.swr`). The index has to outlive whatever it points
    // at, so it takes the same rule: expire with the entry, or never.
    ttlSeconds: (options.swr ?? true) ? undefined : options.maxAge,
  }
}

/**
 * Wraps a handler in Nitro's response cache and keeps its tag index up to date.
 *
 * Returns an ordinary event handler; a route file default-exports it exactly as
 * it would `defineEventHandler`.
 */
export function defineCachedApiHandler<T>(
  options: CachedApiHandlerOptions,
  handler: (event: H3Event) => T | Promise<T>,
) {
  assertCacheName(options.name)

  const swr = options.swr ?? true
  const varies = options.varies ?? []

  return defineCachedEventHandler(
    async (event: H3Event): Promise<T> => {
      const value = await handler(event)
      await indexEntry(event)
      return value
    },
    {
      group: CACHE_ENTRY_GROUP,
      name: options.name,
      maxAge: options.maxAge,
      swr,
      ...(options.staleMaxAge === undefined ? {} : { staleMaxAge: options.staleMaxAge }),
      ...(varies.length === 0 ? {} : { varies: [...varies] }),
      getKey: (event: H3Event) => {
        const entry = resolveCachedEntry(options, event)
        // `getKey` runs on the incoming event, and Nitro hands the wrapped
        // handler an event carrying that same `context` object — the same
        // reference, not a copy — so this is how the two halves communicate.
        event.context.cachedEntry = entry
        // Nitro adds the `app:<name>:` prefix and the `.json` suffix itself.
        return entry.keySuffix
      },
    },
  )
}

/**
 * Writes the tag index for the entry about to be cached.
 *
 * A failure here is logged and swallowed. The alternative is a 500 on a cache
 * miss because the index was briefly unwritable, which turns a Redis blip into
 * an outage on exactly the requests that already cost the most. What that costs
 * is stated plainly in the log line: the entry is cached and no tag will remove
 * it, so it lives out its `maxAge` unless someone sweeps the route by name.
 */
async function indexEntry(event: H3Event): Promise<void> {
  const entry = event.context.cachedEntry
  if (!entry || entry.tags.length === 0) return

  try {
    await registerCacheEntryTags(useCacheStore(), entry.entryKey, entry.tags, entry.ttlSeconds)
  } catch (error) {
    console.error(
      `[cache] could not index ${entry.entryKey}; it will not be removed by tag ` +
        'invalidation, only by expiry or invalidateCachedRoute():',
      error,
    )
  }
}

/** Deletes every cached entry carrying any of `tags`. */
export async function invalidateTags(tags: readonly string[]): Promise<TagInvalidation> {
  return invalidateCacheTags(useCacheStore(), tags)
}

/** Deletes every cached entry of one route, tagged or not. */
export async function invalidateCachedRoute(name: string): Promise<string[]> {
  return invalidateCacheName(useCacheStore(), name)
}
