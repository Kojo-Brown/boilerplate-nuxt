import { describe, it, expect } from 'vitest'

import {
  AsyncDataCache,
  DEFAULT_CACHE_MAX_ENTRIES,
  DEFAULT_CACHE_TTL_MS,
  asyncDataCacheFor,
  asyncDataKey,
} from '../../../utils/asyncDataCache'
import type { CacheHost } from '../../../utils/asyncDataCache'

describe('asyncDataKey', () => {
  it('is the namespace alone when there is nothing to vary on', () => {
    expect(asyncDataKey('posts')).toBe('posts')
    expect(asyncDataKey('posts', {})).toBe('posts')
  })

  it('sorts parameters, because argument order is not part of a request', () => {
    expect(asyncDataKey('posts', { page: 2, limit: 10 })).toBe('posts?limit=10&page=2')
    expect(asyncDataKey('posts', { limit: 10, page: 2 })).toBe('posts?limit=10&page=2')
  })

  it('drops an undefined value, which is a parameter that is not sent', () => {
    expect(asyncDataKey('posts', { page: 2, author: undefined })).toBe('posts?page=2')
    expect(asyncDataKey('posts', { author: undefined })).toBe('posts')
  })

  it('drops an empty array, which also puts nothing on the wire', () => {
    expect(asyncDataKey('posts', { tags: [], page: 1 })).toBe('posts?page=1')
  })

  it('gives a number and its string form the same key, as a query string would', () => {
    expect(asyncDataKey('posts', { page: 2 })).toBe(asyncDataKey('posts', { page: '2' }))
    expect(asyncDataKey('posts', { draft: true })).toBe(asyncDataKey('posts', { draft: 'true' }))
  })

  it('joins an array and keeps its order, which a server may read as meaningful', () => {
    expect(asyncDataKey('posts', { tags: ['a', 'b'] })).toBe('posts?tags=a,b')
    expect(asyncDataKey('posts', { tags: ['b', 'a'] })).not.toBe(
      asyncDataKey('posts', { tags: ['a', 'b'] }),
    )
  })

  describe('separator injection', () => {
    // Each pair is two genuinely different requests whose naive concatenation
    // is identical. A collision here is two `useAsyncData` calls sharing one
    // data ref — one component silently rendering another's response.
    it('keeps a parameter name containing & from splitting into two pairs', () => {
      expect(asyncDataKey('posts', { 'a&b': '1' })).not.toBe(
        asyncDataKey('posts', { a: '', b: '1' }),
      )
    })

    it('keeps a value containing = from moving the pair boundary', () => {
      expect(asyncDataKey('posts', { a: 'b=c' })).not.toBe(asyncDataKey('posts', { 'a=b': 'c' }))
    })

    it('keeps a value containing , from looking like a two-item array', () => {
      expect(asyncDataKey('posts', { tags: 'a,b' })).not.toBe(
        asyncDataKey('posts', { tags: ['a', 'b'] }),
      )
    })

    it('keeps a namespace containing ? from looking like it carries parameters', () => {
      expect(asyncDataKey('posts?page=1')).not.toBe(asyncDataKey('posts', { page: 1 }))
    })
  })

  describe('rejected input', () => {
    it('rejects an empty namespace', () => {
      expect(() => asyncDataKey('')).toThrow(TypeError)
    })

    it.each([
      ['NaN', Number.NaN],
      ['Infinity', Number.POSITIVE_INFINITY],
      ['-Infinity', Number.NEGATIVE_INFINITY],
    ])('rejects %s, which is what a malformed query parameter coerces to', (_label, value) => {
      expect(() => asyncDataKey('posts', { page: value })).toThrow(/does not describe a request/)
    })

    it('rejects a non-finite number inside an array', () => {
      expect(() => asyncDataKey('posts', { ids: [1, Number.NaN] })).toThrow(TypeError)
    })

    it('rejects null, which has no single query-string meaning', () => {
      // @ts-expect-error — the type already forbids it; the guard is for the
      // call sites TypeScript does not see, such as a parsed query object.
      expect(() => asyncDataKey('posts', { author: null })).toThrow(/may only contain/)
    })

    it('rejects an object, which has no query-string form at all', () => {
      // @ts-expect-error — as above.
      expect(() => asyncDataKey('posts', { filter: { tag: 'a' } })).toThrow(/may only contain/)
    })
  })
})

describe('AsyncDataCache', () => {
  it('misses on a key it has never seen', () => {
    const cache = new AsyncDataCache({ ttlMs: 1000 })
    expect(cache.read('posts', 0)).toEqual({ hit: false, reason: 'miss' })
  })

  it('returns what was written, inside the TTL', () => {
    const cache = new AsyncDataCache({ ttlMs: 1000 })
    cache.write('posts', { total: 3 }, 0)

    const read = cache.read<{ total: number }>('posts', 999)
    expect(read.hit).toBe(true)
    if (read.hit) expect(read.entry.value).toEqual({ total: 3 })
  })

  it('expires an entry once it is exactly TTL old, not a millisecond later', () => {
    const cache = new AsyncDataCache({ ttlMs: 1000 })
    cache.write('posts', 'v', 0)

    expect(cache.read('posts', 1000)).toEqual({ hit: false, reason: 'expired' })
  })

  it('drops an expired entry rather than leaving it to be read again', () => {
    const cache = new AsyncDataCache({ ttlMs: 1000 })
    cache.write('posts', 'v', 0)

    expect(cache.read('posts', 2000).hit).toBe(false)
    expect(cache.size).toBe(0)
  })

  it('treats a TTL of 0 as an off switch, and does not hold the value either', () => {
    const cache = new AsyncDataCache({ ttlMs: 0 })
    cache.write('posts', 'v', 0)

    // The write's own eviction sweep collects it immediately: an entry that can
    // never be served is not worth the memory, so this reads as a plain miss
    // rather than as an expiry.
    expect(cache.read('posts', 0)).toEqual({ hit: false, reason: 'miss' })
    expect(cache.size).toBe(0)
  })

  it('clamps a negative TTL to 0 rather than caching forever', () => {
    const cache = new AsyncDataCache({ ttlMs: -1 })
    expect(cache.ttlMs).toBe(0)
  })

  it('defaults to a 30 s TTL and 50 entries', () => {
    const cache = new AsyncDataCache()
    expect(cache.ttlMs).toBe(DEFAULT_CACHE_TTL_MS)
    expect(cache.maxEntries).toBe(DEFAULT_CACHE_MAX_ENTRIES)
  })

  describe('eviction', () => {
    it('drops the oldest write once it is over the cap', () => {
      const cache = new AsyncDataCache({ ttlMs: 10_000, maxEntries: 2 })
      cache.write('a', 1, 0)
      cache.write('b', 2, 1)
      cache.write('c', 3, 2)

      expect(cache.read('a', 3).hit).toBe(false)
      expect(cache.read('b', 3).hit).toBe(true)
      expect(cache.read('c', 3).hit).toBe(true)
    })

    it('counts a re-write as a new write, so a busy key is not evicted first', () => {
      const cache = new AsyncDataCache({ ttlMs: 10_000, maxEntries: 2 })
      cache.write('a', 1, 0)
      cache.write('b', 2, 1)
      cache.write('a', 3, 2) // `a` is now the most recent write
      cache.write('c', 4, 3)

      expect(cache.read('b', 4).hit).toBe(false)
      expect(cache.read('a', 4).hit).toBe(true)
    })

    it('sweeps expired entries on write, so the cap is not spent on dead ones', () => {
      const cache = new AsyncDataCache({ ttlMs: 100, maxEntries: 10 })
      cache.write('a', 1, 0)
      cache.write('b', 2, 0)
      cache.write('c', 3, 500)

      expect(cache.size).toBe(1)
    })

    it('never lets maxEntries be 0, which would make every write a no-op', () => {
      const cache = new AsyncDataCache({ maxEntries: 0 })
      expect(cache.maxEntries).toBe(1)
    })
  })

  it('invalidates one key without touching the others', () => {
    const cache = new AsyncDataCache({ ttlMs: 10_000 })
    cache.write('a', 1, 0)
    cache.write('b', 2, 0)

    cache.invalidate('a')

    expect(cache.read('a', 0).hit).toBe(false)
    expect(cache.read('b', 0).hit).toBe(true)
  })

  it('invalidates everything when called with no key', () => {
    const cache = new AsyncDataCache({ ttlMs: 10_000 })
    cache.write('a', 1, 0)
    cache.write('b', 2, 0)

    cache.invalidate()

    expect(cache.size).toBe(0)
  })

  it('reports age and expiry in a snapshot', () => {
    const cache = new AsyncDataCache({ ttlMs: 1000 })
    cache.write('a', 1, 0, 42)

    expect(cache.snapshot(500)).toEqual([
      { key: 'a', storedAt: 0, bytes: 42, ageMs: 500, expired: false },
    ])
    expect(cache.snapshot(1500)[0]?.expired).toBe(true)
  })

  describe('widen', () => {
    it('raises the TTL for a caller that wants longer', () => {
      const cache = new AsyncDataCache({ ttlMs: 1000 })
      cache.widen({ ttlMs: 5000 })
      expect(cache.ttlMs).toBe(5000)
    })

    it('does not lower it for a caller that wants shorter', () => {
      const cache = new AsyncDataCache({ ttlMs: 5000 })
      cache.widen({ ttlMs: 1000 })
      expect(cache.ttlMs).toBe(5000)
    })

    it('leaves a limit alone when it is not mentioned', () => {
      const cache = new AsyncDataCache({ ttlMs: 5000, maxEntries: 3 })
      cache.widen({ maxEntries: 10 })
      expect(cache.ttlMs).toBe(5000)
      expect(cache.maxEntries).toBe(10)
    })
  })
})

describe('asyncDataCacheFor', () => {
  it('creates the store on first use and returns the same one after', () => {
    const host: CacheHost = {}

    const first = asyncDataCacheFor(host)
    const second = asyncDataCacheFor(host)

    expect(second).toBe(first)
    expect(host._cachedAsyncData).toBe(first)
  })

  it('widens the existing store rather than replacing it', () => {
    const host: CacheHost = {}

    const cache = asyncDataCacheFor(host, { ttlMs: 1000 })
    cache.write('a', 1, 0)

    const again = asyncDataCacheFor(host, { ttlMs: 60_000 })

    expect(again).toBe(cache)
    expect(again.ttlMs).toBe(60_000)
    expect(again.read('a', 0).hit).toBe(true)
  })

  it('gives two hosts two stores — the property that makes it SSR-safe', () => {
    // On the server the host is the NuxtApp, and Nuxt builds one per render.
    // Two hosts sharing a store is exactly how one visitor's response would be
    // served into another visitor's page.
    const requestA: CacheHost = {}
    const requestB: CacheHost = {}

    asyncDataCacheFor(requestA, { ttlMs: 10_000 }).write('me', { name: 'Ada' }, 0)

    expect(asyncDataCacheFor(requestB, { ttlMs: 10_000 }).read('me', 0).hit).toBe(false)
  })
})
