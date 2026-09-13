import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { shallowRef } from 'vue'
import type { ShallowRef } from 'vue'

import { useCachedAsyncData } from '../../../composables/useCachedAsyncData'
import type { AsyncDataCache } from '../../../utils/asyncDataCache'

/**
 * The parts of a NuxtApp this composable reads. `payload.data` is the SSR
 * payload the browser hydrates from, `isHydrating` is true only for the first
 * client-side resolution, and `_cachedAsyncData` is where the store is attached.
 */
interface FakeApp {
  isHydrating: boolean
  payload: { data: Record<string, unknown> }
  _cachedAsyncData?: AsyncDataCache
}

type Cause = 'initial' | 'refresh:hook' | 'refresh:manual' | 'watch'

interface CapturedOptions {
  getCachedData?: (key: string, app: FakeApp, context: { cause: Cause }) => unknown
  [option: string]: unknown
}

/**
 * Stands in for the `useAsyncData` return value, modelling the one thing this
 * composable depends on: Nuxt sets `data` and then moves `status` to `success`,
 * and it only passes through `pending` when it actually fetched. A resolution
 * answered by `getCachedData` goes straight to `success`.
 */
function createFakeAsyncData() {
  const data: ShallowRef<unknown> = shallowRef(undefined)
  const status: ShallowRef<'idle' | 'pending' | 'success' | 'error'> = shallowRef('idle')

  return {
    data,
    status,
    error: shallowRef(undefined),
    pending: shallowRef(false),
    refresh: vi.fn(),
    execute: vi.fn(),
    clear: vi.fn(),

    /** A real fetch: pending, then a value. */
    fetched(value: unknown) {
      status.value = 'pending'
      data.value = value
      status.value = 'success'
    },

    /** A resolution `getCachedData` answered: no pending phase. */
    servedFromCache(value: unknown) {
      data.value = value
      status.value = 'success'
    },
  }
}

interface Harness {
  app: FakeApp
  asyncData: ReturnType<typeof createFakeAsyncData>
  options: CapturedOptions
  /** The stubbed `useAsyncData`, for asserting on what it was handed. */
  spy: ReturnType<typeof vi.fn>
  result: ReturnType<typeof useCachedAsyncData>
  /** Calls the `getCachedData` the composable supplied, as Nuxt would. */
  getCached: (cause: Cause, key?: string) => unknown
}

function mount(
  key: string | (() => string),
  handler: () => Promise<unknown>,
  options: Parameters<typeof useCachedAsyncData>[2] = {},
  app: FakeApp = { isHydrating: false, payload: { data: {} } },
): Harness {
  const asyncData = createFakeAsyncData()
  let captured: CapturedOptions = {}

  const spy = vi.fn((_key: unknown, _handler: unknown, opts: CapturedOptions) => {
    captured = opts
    return asyncData
  })

  vi.stubGlobal('useNuxtApp', () => app)
  vi.stubGlobal('useAsyncData', spy)

  const result = useCachedAsyncData(key, handler, options)

  return {
    app,
    asyncData,
    options: captured,
    spy,
    result,
    getCached: (cause, resolvedKey = typeof key === 'function' ? key() : key) =>
      captured.getCachedData?.(resolvedKey, app, { cause }),
  }
}

const noop = () => Promise.resolve({ ok: true })

describe('useCachedAsyncData', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('passes the key and handler through to useAsyncData untouched', () => {
    const handler = vi.fn(noop)
    const { spy } = mount('posts', handler)

    expect(spy).toHaveBeenCalledWith(
      'posts',
      handler,
      expect.objectContaining({ getCachedData: expect.any(Function) }),
    )
  })

  it('forwards the options it does not own', () => {
    const { options } = mount('posts', noop, { lazy: true, server: false, dedupe: 'defer' })

    expect(options).toMatchObject({ lazy: true, server: false, dedupe: 'defer' })
  })

  it('keeps its own options out of what useAsyncData receives', () => {
    // `ttlMs` is not a `useAsyncData` option. Nuxt hashes the options it is
    // given in dev to detect conflicting calls on one key, so passing unknown
    // keys through is not free.
    const { options } = mount('posts', noop, { ttlMs: 1000, maxEntries: 5, payloadBudgetBytes: 1 })

    expect(options).not.toHaveProperty('ttlMs')
    expect(options).not.toHaveProperty('maxEntries')
    expect(options).not.toHaveProperty('payloadBudgetBytes')
  })

  describe('hydration', () => {
    it('answers the first client resolution from the SSR payload', () => {
      const app: FakeApp = { isHydrating: true, payload: { data: { posts: { total: 3 } } } }
      const harness = mount('posts', noop, {}, app)

      expect(harness.getCached('initial')).toEqual({ total: 3 })
      expect(harness.result.cacheStatus.value).toBe('hydration')
    })

    it('seeds the store from the payload, so a later navigation is a hit', () => {
      const app: FakeApp = { isHydrating: true, payload: { data: { posts: { total: 3 } } } }
      const harness = mount('posts', noop, { ttlMs: 60_000 }, app)

      harness.getCached('initial')
      app.isHydrating = false

      expect(harness.getCached('initial')).toEqual({ total: 3 })
      expect(harness.result.cacheStatus.value).toBe('hit')
    })

    it('measures the payload it hydrated from, which is where the bytes were paid', () => {
      // The SSR payload is the whole point of the budget: those bytes were
      // inside the HTML document, downloaded before anything rendered. A
      // report that only covered client-side fetches would be silent on
      // exactly the case that matters.
      const app: FakeApp = {
        isHydrating: true,
        payload: { data: { posts: { id: 'post-1', body: 'x'.repeat(500) } } },
      }
      const harness = mount('posts', noop, { payloadBudgetBytes: 64 }, app)

      harness.getCached('initial')

      expect(harness.result.payload.value?.withinBudget).toBe(false)
      expect(harness.result.payload.value?.largestFields[0]?.field).toBe('body')
      expect(harness.result.cacheSnapshot()[0]?.bytes).toBeGreaterThan(500)
    })

    it('falls through to a fetch when the payload has nothing for the key', () => {
      const app: FakeApp = { isHydrating: true, payload: { data: {} } }
      const harness = mount('posts', noop, {}, app)

      expect(harness.getCached('initial')).toBeUndefined()
      expect(harness.result.cacheStatus.value).toBe('miss')
    })
  })

  describe('cause handling', () => {
    function primed() {
      const harness = mount('posts', noop, { ttlMs: 60_000 })
      harness.asyncData.fetched({ total: 3 })
      return harness
    }

    it('serves an initial resolution from the store', () => {
      const harness = primed()

      expect(harness.getCached('initial')).toEqual({ total: 3 })
      expect(harness.result.cacheStatus.value).toBe('hit')
    })

    it('serves a watch-triggered resolution from the store', () => {
      // This is the pagination case: page 2, then back to page 1. The key
      // changed, so Nuxt re-resolves with cause `watch`, and page 1 is already
      // in hand.
      const harness = primed()

      expect(harness.getCached('watch')).toEqual({ total: 3 })
      expect(harness.result.cacheStatus.value).toBe('hit')
    })

    it('never answers refresh(), which would make the button a no-op', () => {
      // Nuxt's `granularCachedData` defaults to true, so `getCachedData` really
      // is consulted here. Returning a stored value would break every refresh
      // button in the app for the length of the TTL, silently.
      const harness = primed()

      expect(harness.getCached('refresh:manual')).toBeUndefined()
      expect(harness.result.cacheStatus.value).toBe('bypass')
    })

    it('never answers refreshNuxtData(), the app-wide invalidation signal', () => {
      const harness = primed()

      expect(harness.getCached('refresh:hook')).toBeUndefined()
      expect(harness.result.cacheStatus.value).toBe('bypass')
    })
  })

  describe('expiry', () => {
    it('stops serving once the TTL has passed', () => {
      const harness = mount('posts', noop, { ttlMs: 1000 })
      harness.asyncData.fetched({ total: 3 })

      vi.setSystemTime(1001)

      expect(harness.getCached('initial')).toBeUndefined()
      expect(harness.result.cacheStatus.value).toBe('expired')
    })

    it('serves again after a fresh fetch', () => {
      const harness = mount('posts', noop, { ttlMs: 1000 })
      harness.asyncData.fetched({ total: 3 })

      vi.setSystemTime(1001)
      harness.getCached('initial')
      harness.asyncData.fetched({ total: 4 })

      expect(harness.getCached('initial')).toEqual({ total: 4 })
    })
  })

  describe('what gets stored', () => {
    it('stores a fetched value under the key in use', () => {
      const harness = mount('posts', noop, { ttlMs: 60_000 })
      harness.asyncData.fetched({ total: 3 })

      expect(harness.result.cacheSnapshot().map((entry) => entry.key)).toEqual(['posts'])
    })

    it('does not re-stamp an entry it just served, which would extend the TTL forever', () => {
      // A cache hit sets `data` and `status` too. If the store were written on
      // every data change, an entry read once per second with a 30 s TTL would
      // never expire — the cache would quietly become permanent.
      const harness = mount('posts', noop, { ttlMs: 1000 })
      harness.asyncData.fetched({ total: 3 })

      vi.setSystemTime(900)
      harness.asyncData.servedFromCache({ total: 3 })
      vi.setSystemTime(1001)

      expect(harness.getCached('initial')).toBeUndefined()
    })

    it('stores under the key the getter resolves to now, not the one it started with', () => {
      let page = 1
      const harness = mount(() => `posts?page=${page}`, noop, { ttlMs: 60_000 })

      harness.asyncData.fetched({ page: 1 })
      page = 2
      harness.asyncData.fetched({ page: 2 })

      expect(harness.result.cacheSnapshot().map((entry) => entry.key)).toEqual([
        'posts?page=1',
        'posts?page=2',
      ])
      expect(harness.getCached('watch', 'posts?page=1')).toEqual({ page: 1 })
    })

    it('evicts past maxEntries', () => {
      let page = 0
      const harness = mount(() => `posts?page=${page}`, noop, { ttlMs: 60_000, maxEntries: 2 })

      for (page = 1; page <= 3; page += 1) harness.asyncData.fetched({ page })

      expect(harness.result.cacheSnapshot().map((entry) => entry.key)).toEqual([
        'posts?page=2',
        'posts?page=3',
      ])
    })

    it('ignores a failed fetch', () => {
      const harness = mount('posts', noop, { ttlMs: 60_000 })
      harness.asyncData.status.value = 'pending'
      harness.asyncData.status.value = 'error'

      expect(harness.result.cacheSnapshot()).toEqual([])
    })
  })

  describe('payload budget', () => {
    it('has nothing to report until something is fetched', () => {
      const harness = mount('posts', noop)

      expect(harness.result.payload.value).toBeNull()
    })

    it('measures every fetched value against the budget', () => {
      const harness = mount('posts', noop, { payloadBudgetBytes: 1024 })
      harness.asyncData.fetched({ id: 'post-1' })

      expect(harness.result.payload.value).toMatchObject({
        key: 'posts',
        withinBudget: true,
        budgetBytes: 1024,
      })
    })

    it('reports the fields to drop when a response outgrows its budget', () => {
      const harness = mount('posts', noop, { payloadBudgetBytes: 64 })
      harness.asyncData.fetched({ id: 'post-1', body: 'x'.repeat(500) })

      const report = harness.result.payload.value
      expect(report?.withinBudget).toBe(false)
      expect(report?.largestFields[0]?.field).toBe('body')
    })

    it('records the measured size on the cache entry', () => {
      const harness = mount('posts', noop, { ttlMs: 60_000 })
      harness.asyncData.fetched({ id: 'post-1' })

      expect(harness.result.cacheSnapshot()[0]?.bytes).toBe(
        new TextEncoder().encode(JSON.stringify({ id: 'post-1' })).length,
      )
    })
  })

  it('exposes the key in use, and tracks a reactive one', () => {
    // A computed, so it follows the refs a key getter reads — which is how a
    // key getter is written in practice, and how Nuxt itself watches the key.
    const page = shallowRef(1)
    const harness = mount(() => `posts?page=${page.value}`, noop)

    expect(harness.result.cacheKey.value).toBe('posts?page=1')
    page.value = 2
    expect(harness.result.cacheKey.value).toBe('posts?page=2')
  })

  it('invalidate() drops the key so the next resolution fetches', () => {
    const harness = mount('posts', noop, { ttlMs: 60_000 })
    harness.asyncData.fetched({ total: 3 })

    harness.result.invalidate()

    expect(harness.getCached('initial')).toBeUndefined()
    expect(harness.result.cacheStatus.value).toBe('miss')
  })

  it('shares one store between two composables on the same NuxtApp', () => {
    const app: FakeApp = { isHydrating: false, payload: { data: {} } }
    const first = mount('posts', noop, { ttlMs: 60_000 }, app)
    first.asyncData.fetched({ total: 3 })

    const second = mount('posts', noop, { ttlMs: 60_000 }, app)

    expect(second.getCached('initial')).toEqual({ total: 3 })
  })

  it('keeps two NuxtApps apart, which is what makes it safe on the server', () => {
    const first = mount('me', noop, { ttlMs: 60_000 })
    first.asyncData.fetched({ name: 'Ada' })

    const second = mount(
      'me',
      noop,
      { ttlMs: 60_000 },
      {
        isHydrating: false,
        payload: { data: {} },
      },
    )

    expect(second.getCached('initial')).toBeUndefined()
  })
})
