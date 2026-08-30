import type { H3Event } from 'h3'
import { createStorage } from 'unstorage'
import memoryDriver from 'unstorage/drivers/memory'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

import { cacheEntryKey, cacheKeySuffix, taggedEntryKeys } from '~/server/utils/cache-tags'
import {
  defineCachedApiHandler,
  invalidateCachedRoute,
  invalidateTags,
  resolveCachedEntry,
  varyKeyParts,
  type CachedApiHandlerOptions,
} from '~/server/utils/cached-route'

/**
 * The wrapper's two halves are tested differently, because only one of them is
 * this project's code.
 *
 * The **key** — what `resolveCachedEntry` computes — is checked against Nitro's
 * real rules in `cache-tags.test.ts`, which copies `escapeKey` and the key
 * composition out of `nitropack` and pins them against a live `unstorage`.
 *
 * The **wiring** is checked here against a stand-in for
 * `defineCachedEventHandler` that reproduces the parts of its contract this
 * module depends on: it calls `getKey` on the incoming event, it calls the
 * wrapped handler only when it needs a fresh value, and it hands that handler an
 * event carrying the same `context` object. Importing the real one would mean
 * booting a Nitro app; reproducing its contract states, in one place, exactly
 * what this module is assuming of it.
 */
interface FakeCachedHandler {
  (event: H3Event): Promise<unknown>
  /** What Nitro was asked for, so the options can be asserted. */
  options: Record<string, unknown>
  /** Requests answered from the cache instead of the handler. */
  hits: number
}

/** Entries the fake "cached" — key to value, standing in for Nitro's own store. */
let cached: Map<string, unknown>

function fakeDefineCachedEventHandler(
  handler: (event: H3Event) => Promise<unknown>,
  options: Record<string, unknown>,
): FakeCachedHandler {
  const wrapped = async (event: H3Event): Promise<unknown> => {
    const getKey = options['getKey'] as (event: H3Event) => string
    const key = getKey(event)

    if (cached.has(key)) {
      wrapped.hits++
      return cached.get(key)
    }

    const value = await handler(event)
    cached.set(key, value)
    return value
  }

  wrapped.options = options
  wrapped.hits = 0
  return wrapped
}

function createEvent(headers: Record<string, string> = {}): H3Event {
  return { path: '/api/cached/catalog', context: {}, headers } as unknown as H3Event
}

let store: ReturnType<typeof createStorage>
let storageFails = false

beforeEach(() => {
  cached = new Map()
  store = createStorage({ driver: memoryDriver() })
  storageFails = false

  vi.stubGlobal('defineCachedEventHandler', fakeDefineCachedEventHandler)
  vi.stubGlobal('useStorage', () => {
    if (storageFails) throw new Error('redis is down')
    return store
  })
  vi.stubGlobal('getRequestHeader', (event: H3Event, name: string) => {
    return (event as unknown as { headers: Record<string, string> }).headers[name.toLowerCase()]
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const catalogOptions: CachedApiHandlerOptions = {
  name: 'catalog',
  maxAge: 30,
  key: () => ['2'],
  tags: ['catalog'],
}

describe('resolveCachedEntry', () => {
  it('builds the entry key from the route name and the key parts', () => {
    const entry = resolveCachedEntry(catalogOptions, createEvent())

    expect(entry.keySuffix).toBe(cacheKeySuffix(['2']))
    expect(entry.entryKey).toBe(cacheEntryKey('catalog', cacheKeySuffix(['2'])))
  })

  it('keys a route with no key function as a single entry', () => {
    const entry = resolveCachedEntry({ name: 'stats', maxAge: 10, tags: [] }, createEvent())
    expect(entry.entryKey).toBe(cacheEntryKey('stats', cacheKeySuffix([])))
  })

  it('resolves tags from the request when they are a function', () => {
    const entry = resolveCachedEntry(
      { ...catalogOptions, tags: () => ['catalog:2', 'catalog', 'catalog'] },
      createEvent(),
    )
    expect(entry.tags).toEqual(['catalog', 'catalog:2'])
  })

  it('folds varied headers into the key, which Nitro would not do here', () => {
    // Nitro's `varies` is skipped entirely once a custom `getKey` is supplied,
    // so without this the two languages would share one cached response.
    const english = resolveCachedEntry(
      { ...catalogOptions, varies: ['accept-language'] },
      createEvent({ 'accept-language': 'en' }),
    )
    const french = resolveCachedEntry(
      { ...catalogOptions, varies: ['accept-language'] },
      createEvent({ 'accept-language': 'fr' }),
    )

    expect(english.entryKey).not.toBe(french.entryKey)
  })

  it('distinguishes a missing varied header from an empty one', () => {
    const options = { ...catalogOptions, varies: ['accept-language'] }
    const absent = resolveCachedEntry(options, createEvent())
    const empty = resolveCachedEntry(options, createEvent({ 'accept-language': '' }))

    expect(absent.entryKey).toBe(empty.entryKey)
  })

  it('gives the index no TTL while stale entries are served, and the entry TTL otherwise', () => {
    // Nitro stores a TTL only when `maxAge && !swr`. An index key that expired
    // before the entry it points at would leave that entry uninvalidatable.
    expect(resolveCachedEntry(catalogOptions, createEvent()).ttlSeconds).toBeUndefined()
    expect(resolveCachedEntry({ ...catalogOptions, swr: false }, createEvent()).ttlSeconds).toBe(30)
  })
})

describe('varyKeyParts', () => {
  it('lowercases the header name so two spellings key the same entry', () => {
    const event = createEvent({ 'accept-language': 'en' })
    expect(varyKeyParts(event, ['Accept-Language'])).toEqual(['accept-language=en'])
  })
})

describe('defineCachedApiHandler', () => {
  it('rejects a name that would not survive being written into a storage key', () => {
    expect(() => defineCachedApiHandler({ ...catalogOptions, name: 'A/B' }, () => 1)).toThrow(
      /Invalid cache name/,
    )
  })

  it('passes the caching options Nitro needs, and omits the ones not set', () => {
    const handler = defineCachedApiHandler(catalogOptions, () => 1) as unknown as FakeCachedHandler

    expect(handler.options).toMatchObject({ group: 'app', name: 'catalog', maxAge: 30, swr: true })
    expect(handler.options).not.toHaveProperty('staleMaxAge')
    expect(handler.options).not.toHaveProperty('varies')
  })

  it('still passes varies through, because it also filters the handler request', () => {
    const handler = defineCachedApiHandler(
      { ...catalogOptions, varies: ['accept-language'], staleMaxAge: 60 },
      () => 1,
    ) as unknown as FakeCachedHandler

    expect(handler.options).toMatchObject({ varies: ['accept-language'], staleMaxAge: 60 })
  })

  it('returns the key Nitro should store under, not the full storage key', () => {
    const handler = defineCachedApiHandler(catalogOptions, () => 1) as unknown as FakeCachedHandler
    const getKey = handler.options['getKey'] as (event: H3Event) => string

    expect(getKey(createEvent())).toBe(cacheKeySuffix(['2']))
  })

  it('indexes the rendered entry under its tags', async () => {
    const handler = defineCachedApiHandler(catalogOptions, () => ({ ok: true }))

    await handler(createEvent())

    expect(await taggedEntryKeys(store, 'catalog')).toEqual([
      cacheEntryKey('catalog', cacheKeySuffix(['2'])),
    ])
  })

  it('does not touch the index on a cache hit', async () => {
    let renders = 0
    const handler = defineCachedApiHandler(catalogOptions, () => ({ renders: ++renders }))

    await handler(createEvent())
    await store.clear()
    const second = await handler(createEvent())

    // The handler never ran again, so nothing was written that needed indexing.
    expect(second).toEqual({ renders: 1 })
    expect(await store.getKeys()).toEqual([])
  })

  it('makes the entry key available to the handler through the request context', async () => {
    let seen: string | undefined
    const handler = defineCachedApiHandler(catalogOptions, (event) => {
      seen = event.context.cachedEntry?.entryKey
      return 1
    })

    await handler(createEvent())

    expect(seen).toBe(cacheEntryKey('catalog', cacheKeySuffix(['2'])))
  })

  it('skips the index write for an untagged route', async () => {
    const handler = defineCachedApiHandler({ name: 'stats', maxAge: 10, tags: [] }, () => 1)

    await handler(createEvent())

    expect(await store.getKeys()).toEqual([])
  })

  it('serves the response when the index cannot be written, and says what that cost', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    storageFails = true

    const handler = defineCachedApiHandler(catalogOptions, () => ({ ok: true }))

    // A Redis blip must not turn into a 500 on every cache miss. The trade is
    // that the entry is cached and no tag will remove it, which the log says.
    await expect(handler(createEvent())).resolves.toEqual({ ok: true })
    expect(logged).toHaveBeenCalledWith(
      expect.stringContaining('will not be removed by tag invalidation'),
      expect.any(Error),
    )
  })

  it('lets the handler error through instead of caching it', async () => {
    const handler = defineCachedApiHandler(catalogOptions, () => {
      throw new Error('upstream down')
    })

    await expect(handler(createEvent())).rejects.toThrow('upstream down')
    expect(await store.getKeys()).toEqual([])
  })
})

describe('invalidating what a cached route wrote', () => {
  /**
   * The round trip, through the app-level entry points rather than the injected
   * ones: render, then invalidate, and check that what came off the store is
   * what the handler put there. It is the one assertion that would still fail if
   * the render and the invalidation each worked but keyed differently.
   */
  it('removes by tag the entry a render put there', async () => {
    const handler = defineCachedApiHandler(catalogOptions, () => ({ ok: true }))
    await handler(createEvent())

    const entryKey = cacheEntryKey('catalog', cacheKeySuffix(['2']))
    // Stand in for Nitro's own write, which the fake handler above does not do.
    await store.setItem(entryKey, { body: 'cached' })

    expect(await invalidateTags(['catalog'])).toEqual({ tags: ['catalog'], entries: [entryKey] })
    expect(await store.getItem(entryKey)).toBeNull()
    expect(await taggedEntryKeys(store, 'catalog')).toEqual([])
  })

  it('removes by route name an entry that was never indexed', async () => {
    const untagged = cacheEntryKey('catalog', cacheKeySuffix(['9']))
    await store.setItem(untagged, { body: 'from a build before the tag existed' })

    expect(await invalidateCachedRoute('catalog')).toEqual([untagged])
    expect(await store.getItem(untagged)).toBeNull()
  })
})
