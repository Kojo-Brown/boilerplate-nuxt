import { computed, shallowRef, toValue, watch } from 'vue'
import type { ComputedRef, MaybeRefOrGetter, ShallowRef } from 'vue'

import {
  DEFAULT_CACHE_MAX_ENTRIES,
  DEFAULT_CACHE_TTL_MS,
  asyncDataCacheFor,
} from '../utils/asyncDataCache'
import type { AsyncDataCacheSnapshot } from '../utils/asyncDataCache'
import {
  DEFAULT_PAYLOAD_BUDGET_BYTES,
  checkPayloadBudget,
  payloadBudgetWarning,
} from '../utils/payloadBudget'
import type { PayloadBudgetReport } from '../utils/payloadBudget'

import type { AsyncDataOptions } from '#app'

/**
 * Nuxt exports `AsyncDataOptions` from `#app` but not the two helper types this
 * wrapper needs, so both are read back out of it. Derived rather than
 * re-declared: a copy would keep compiling after Nuxt changed the original,
 * and the mismatch would surface as a wrong `cause` at runtime.
 */
type GetCachedData<DataT> = NonNullable<AsyncDataOptions<DataT>['getCachedData']>

/** `'initial' | 'refresh:hook' | 'refresh:manual' | 'watch'`. */
type AsyncDataRefreshCause = Parameters<GetCachedData<unknown>>[2]['cause']

/** The array shape Nuxt's `pick` option takes for a given data type. */
type KeysOf<T> = NonNullable<AsyncDataOptions<unknown, T>['pick']>

declare module '#app' {
  interface NuxtApp {
    /**
     * The TTL store behind `useCachedAsyncData`. Per-NuxtApp, so per-request on
     * the server. Declared optional because it is created on first use rather
     * than by a plugin — a page that never caches never allocates it.
     */
    _cachedAsyncData?: import('../utils/asyncDataCache').AsyncDataCache
  }
}

/** How the last resolution of this key was answered. */
export type CacheStatus =
  /** Nothing has resolved yet. */
  | 'idle'
  /** Served from the store. */
  | 'hit'
  /** Nothing stored for this key. */
  | 'miss'
  /** Something was stored and had aged past the TTL. */
  | 'expired'
  /** An explicit refresh, which is never answered from cache. */
  | 'bypass'
  /** The first client-side resolution, answered from the SSR payload. */
  | 'hydration'

/**
 * Causes that may be answered from cache.
 *
 * `refresh:manual` is `refresh()` — somebody asked for current data, and
 * handing them a stored copy would make the button a no-op. `refresh:hook` is
 * `refreshNuxtData()`, which is how the rest of the app says "this is stale
 * now"; answering it from the store would defeat the only invalidation signal
 * Nuxt has.
 *
 * This distinction is load-bearing rather than cosmetic. Nuxt's
 * `granularCachedData` defaults to **true**, so `getCachedData` is consulted on
 * a manual refresh as well as on the initial load — a TTL cache that ignores
 * `cause` silently breaks every refresh button in the app for the length of its
 * TTL, and does it without an error anywhere.
 */
function isCacheableCause(cause: AsyncDataRefreshCause): boolean {
  return cause === 'initial' || cause === 'watch'
}

export interface CachedAsyncDataExtras {
  /** How the last resolution was answered. See {@link CacheStatus}. */
  cacheStatus: Readonly<ShallowRef<CacheStatus>>
  /** The key currently in use — the resolved value when `key` is a getter. */
  cacheKey: ComputedRef<string>
  /**
   * What the last fetched value measured, and whether it fit its budget.
   * `null` until something has been fetched (a cache hit does not re-measure).
   */
  payload: Readonly<ShallowRef<PayloadBudgetReport | null>>
  /** Drops this key from the store, so the next resolution fetches. */
  invalidate: () => void
  /** Everything the store holds, for a debug panel or a test. */
  cacheSnapshot: () => readonly AsyncDataCacheSnapshot[]
}

export interface CachedAsyncDataOptions<
  ResT,
  DataT = ResT,
  PickKeys extends KeysOf<DataT> = KeysOf<DataT>,
  DefaultT = undefined,
  // `getCachedData` is omitted rather than merged: this composable exists to
  // supply it, and two implementations of one option can only disagree.
> extends Omit<AsyncDataOptions<ResT, DataT, PickKeys, DefaultT>, 'getCachedData'> {
  /** How long a stored value may be served. Default 30 s. */
  ttlMs?: number
  /** Cap on entries held per NuxtApp. Default 50. See below on why it matters. */
  maxEntries?: number
  /**
   * Size this response is expected to stay under, in bytes. Default 16 kB.
   * Exceeding it warns in dev and is reported through `payload`; it never
   * changes what is fetched or stored.
   */
  payloadBudgetBytes?: number
}

/**
 * `useAsyncData` with a TTL cache and a payload budget.
 *
 * Nuxt's default `getCachedData` reuses data on hydration and then never again:
 * every later mount of a component — a tab switched away from and back, a
 * paginated list returning to page 1, a route revisited — refetches. That is
 * the safe default, and it is the wrong one for data that is expensive and
 * barely changes. Passing a TTL here makes those remounts free for `ttlMs`,
 * while `refresh()` and `refreshNuxtData()` keep working exactly as before.
 *
 * ```ts
 * const { data, cacheStatus } = useCachedAsyncData(
 *   () => asyncDataKey('posts', { page: page.value, limit: limit.value }),
 *   () => $fetch('/api/posts', { params: { page: page.value, limit: limit.value } }),
 *   { ttlMs: 60_000, transform: (res) => res.data.map((p) => ({ id: p.id, title: p.title })) },
 * )
 * ```
 *
 * Two things to know before reaching for it:
 *
 * **Supplying `getCachedData` turns off Nuxt's own cleanup.** Nuxt's
 * `purgeCachedData` sweep skips any key with a custom `getCachedData`, so
 * `nuxtApp.payload.data[key]` and the entry here both outlive the component.
 * That is why `maxEntries` exists and why it is a cap rather than advice.
 *
 * **The store is not shared between visitors.** It hangs off the NuxtApp, which
 * Nuxt creates per render on the server, so a server-side hit is impossible by
 * construction — the cache is a client-side navigation optimisation, not a
 * server cache. For a real server cache see `docs/nitro-cached-functions.md`.
 *
 * Like `usePollingData`, the return value is a plain object rather than the
 * thenable `useAsyncData` hands back, so it cannot be `await`ed directly; await
 * `refresh()` instead.
 */
export function useCachedAsyncData<
  ResT,
  DataT = ResT,
  PickKeys extends KeysOf<DataT> = KeysOf<DataT>,
  DefaultT = undefined,
>(
  key: MaybeRefOrGetter<string>,
  handler: () => Promise<ResT>,
  options: CachedAsyncDataOptions<ResT, DataT, PickKeys, DefaultT> = {},
) {
  const {
    ttlMs = DEFAULT_CACHE_TTL_MS,
    maxEntries = DEFAULT_CACHE_MAX_ENTRIES,
    payloadBudgetBytes = DEFAULT_PAYLOAD_BUDGET_BYTES,
    ...asyncDataOptions
  } = options

  const nuxtApp = useNuxtApp()
  const cache = asyncDataCacheFor(nuxtApp, { ttlMs, maxEntries })

  const cacheStatus = shallowRef<CacheStatus>('idle')
  const payload = shallowRef<PayloadBudgetReport | null>(null)
  const cacheKey = computed(() => toValue(key))

  /**
   * Measures a value, records the report, stores it, and warns in dev.
   *
   * Shared by the two paths that produce a value the app did not already have —
   * a client-side fetch, and the SSR payload read on hydration. Both are
   * measured because both are the payload: the hydration path is the one where
   * the bytes were actually paid for, inside the HTML document, before anything
   * rendered.
   */
  function record(resolvedKey: string, value: unknown): void {
    const report = checkPayloadBudget(resolvedKey, value, payloadBudgetBytes)
    payload.value = report
    cache.write(resolvedKey, value, Date.now(), report.bytes)

    if (import.meta.dev) {
      const warning = payloadBudgetWarning(report)
      if (warning !== null) console.warn(warning)
    }
  }

  const asyncData = useAsyncData<ResT, unknown, DataT, PickKeys, DefaultT>(key, handler, {
    ...asyncDataOptions,

    getCachedData(resolvedKey, app, context) {
      // Hydration is answered from the payload, which is what the default
      // implementation does and what the SSR render already paid for. Skipping
      // it would make every cached page fetch twice on first load — once on the
      // server, once again in the browser — which is strictly worse than not
      // caching at all.
      if (app.isHydrating) {
        const hydrated = app.payload.data[resolvedKey] as DataT | undefined
        if (hydrated !== undefined) {
          // Seeded so a later navigation back to this key can be served
          // locally. `storedAt` is now rather than when the server fetched it:
          // the render time is not carried in the payload, and dating the entry
          // from hydration only ever makes it expire sooner.
          record(resolvedKey, hydrated)
          cacheStatus.value = 'hydration'
          return hydrated
        }
        cacheStatus.value = 'miss'
        return undefined
      }

      if (!isCacheableCause(context.cause)) {
        cacheStatus.value = 'bypass'
        return undefined
      }

      const read = cache.read<DataT>(resolvedKey, Date.now())
      if (!read.hit) {
        cacheStatus.value = read.reason
        return undefined
      }

      cacheStatus.value = 'hit'
      return read.entry.value
    },
  })

  // A completed fetch is exactly a `pending` → `success` transition: Nuxt sets
  // `status` straight to `success` when `getCachedData` answered, without
  // passing through `pending`. Watching the transition rather than watching
  // `data` is what keeps a cache hit from re-stamping its own entry and
  // extending the TTL forever.
  //
  // `flush: 'sync'` because the default `pre` flush coalesces, and a fetch that
  // resolves in the same tick as the next one starts would be stored once
  // instead of twice — with whichever value happened to land last.
  watch(
    asyncData.status,
    (status, previous) => {
      if (status !== 'success' || previous !== 'pending') return

      // Read through `toValue` rather than the computed: this runs inside a
      // sync watcher, and a computed invalidated in the same tick would still
      // be serving its previous value.
      record(toValue(key), asyncData.data.value)
    },
    { flush: 'sync' },
  )

  return {
    ...asyncData,
    cacheStatus,
    cacheKey,
    payload,
    invalidate: () => {
      cache.invalidate(toValue(key))
    },
    cacheSnapshot: () => cache.snapshot(Date.now()),
  }
}
