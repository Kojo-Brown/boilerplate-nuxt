import { createStorage, prefixStorage, type StorageValue } from 'unstorage'
import memoryDriver from 'unstorage/drivers/memory'
import { describe, it, expect, beforeEach } from 'vitest'

import {
  CACHE_ENTRY_GROUP,
  EMPTY_KEY_SUFFIX,
  assertCacheName,
  cacheEntryKey,
  cacheKeySuffix,
  cacheNamePrefix,
  decodeKeySegment,
  encodeKeySegment,
  entryKeyFromIndexKey,
  invalidateCacheName,
  invalidateCacheTags,
  normaliseTags,
  registerCacheEntryTags,
  tagIndexKey,
  tagIndexPrefix,
  taggedEntryKeys,
} from '~/server/utils/cache-tags'
import { CACHE_BASE } from '~/server/utils/storage'

/**
 * Nitro's `escapeKey`, copied verbatim from
 * `nitropack/dist/runtime/internal/cache.mjs` (2.13.4).
 *
 * Every custom cache key goes through it. Copying it rather than importing is
 * deliberate: importing that module pulls in `useNitroApp` and a running Nitro.
 * What the copy buys is that the tests below assert against the real rule —
 * "characters outside `[A-Za-z0-9_]` are deleted, not encoded" — instead of
 * against a description of it.
 */
function escapeKey(key: string): string {
  return String(key).replace(/\W/g, '')
}

/**
 * Nitro's cache-entry key composition, also copied verbatim from
 * `defineCachedFunction` in the same file, with its defaults (`base: "/cache"`).
 */
function nitroEntryKey(group: string, name: string, key: string): string {
  return ['/cache', group, name, key + '.json'].filter(Boolean).join(':').replace(/:\/$/, ':index')
}

const NASTY_INPUTS = [
  'catalog',
  'catalog:42',
  'page-2',
  'a_b',
  '_',
  '__',
  '',
  '/',
  '?page=2',
  'a:b/c?d',
  'Ünïcøde',
  '日本語',
  '🙂',
  'x'.repeat(50),
  '550e8400-e29b-41d4-a716-446655440000',
]

describe('encodeKeySegment', () => {
  it('leaves alphanumerics alone', () => {
    expect(encodeKeySegment('catalog42')).toBe('catalog42')
  })

  it('escapes everything else as underscore-hex', () => {
    expect(encodeKeySegment('catalog:42')).toBe('catalog_3a42')
    expect(encodeKeySegment('page-2')).toBe('page_2d2')
  })

  it('escapes the underscore itself, so the escape marker is unambiguous', () => {
    expect(encodeKeySegment('a_b')).toBe('a_5fb')
  })

  it('escapes a multi-byte character one byte at a time', () => {
    expect(encodeKeySegment('é')).toBe('_c3_a9')
  })

  it.each(NASTY_INPUTS)('emits only characters escapeKey keeps, for %j', (input) => {
    // The point of the whole encoding. Nitro deletes anything outside
    // [A-Za-z0-9_] from a custom key rather than encoding it, so an encoding
    // that strayed outside that set would have characters silently removed and
    // two different requests would share one cache entry.
    const encoded = encodeKeySegment(input)
    expect(escapeKey(encoded)).toBe(encoded)
  })

  it('is injective on inputs that escapeKey would collapse together', () => {
    // `page:2` and `page-2` are both `page2` after escapeKey.
    expect(escapeKey('page:2')).toBe(escapeKey('page-2'))
    expect(encodeKeySegment('page:2')).not.toBe(encodeKeySegment('page-2'))
  })
})

describe('decodeKeySegment', () => {
  it.each(NASTY_INPUTS)('round-trips %j', (input) => {
    expect(decodeKeySegment(encodeKeySegment(input))).toBe(input)
  })

  it('rebuilds a multi-byte character from consecutive escapes', () => {
    // Decoding byte by byte would produce two replacement characters here.
    expect(decodeKeySegment('_f0_9f_99_82')).toBe('🙂')
  })

  it('passes through an underscore the encoder could not have produced', () => {
    // A key from somewhere else sharing the store should read as itself, not
    // throw in the middle of an invalidation sweep.
    expect(decodeKeySegment('a_zz')).toBe('a_zz')
    expect(decodeKeySegment('trailing_')).toBe('trailing_')
  })
})

describe('cacheKeySuffix', () => {
  it('never returns the empty string', () => {
    // Nitro tests a custom key for truthiness and falls back to its own path
    // hash when it is falsy, which would make the entry unfindable.
    expect(cacheKeySuffix([])).toBe(EMPTY_KEY_SUFFIX)
    expect(cacheKeySuffix([''])).toBe(EMPTY_KEY_SUFFIX)
    expect(EMPTY_KEY_SUFFIX).not.toBe('')
  })

  it('does not let a real part list reach the empty-key sentinel', () => {
    for (const parts of [['_'], ['', ''], ['index'], ['a'], ['', 'a']]) {
      expect(cacheKeySuffix(parts)).not.toBe(EMPTY_KEY_SUFFIX)
    }
  })

  it('joins encoded parts with a separator no encoded part can contain', () => {
    expect(cacheKeySuffix(['catalog', '2'])).toBe('catalog__2')
  })

  it('keeps parts distinct that a single-underscore join would merge', () => {
    // With `_` as the separator both of these would be `a_5f`.
    expect(cacheKeySuffix(['a', '5f'])).not.toBe(cacheKeySuffix(['a_']))
  })

  it('keeps part boundaries, so ["ab","c"] and ["a","bc"] are different entries', () => {
    expect(cacheKeySuffix(['ab', 'c'])).not.toBe(cacheKeySuffix(['a', 'bc']))
  })

  it.each([[['a', '5f']], [['a_']], [['', '']], [['a:b', 'c/d']]])(
    'survives escapeKey unchanged for %j',
    (parts: string[]) => {
      const suffix = cacheKeySuffix(parts)
      expect(escapeKey(suffix)).toBe(suffix)
    },
  )
})

describe('assertCacheName', () => {
  it.each(['catalog', 'catalog-item', 'a1'])('accepts %s', (name) => {
    expect(() => assertCacheName(name)).not.toThrow()
  })

  it.each(['', 'Catalog', '1catalog', 'catalog/item', 'catalog:item', 'catalog?x'])(
    'rejects %j, which is interpolated into the storage key unescaped',
    (name) => {
      expect(() => assertCacheName(name)).toThrow(/Invalid cache name/)
    },
  )
})

describe('the entry key matches the one Nitro writes', () => {
  it('is group, name and key, with the .json suffix Nitro adds', () => {
    expect(cacheEntryKey('catalog', 'page__2')).toBe('app:catalog:page__2.json')
    expect(CACHE_ENTRY_GROUP).toBe('app')
  })

  it('finds an entry Nitro wrote, through the same base the app reads', async () => {
    // The end-to-end claim invalidation rests on: Nitro writes to the *root*
    // storage with a `/cache:…` key, and this app removes it through
    // `useStorage('cache')`. If unstorage's key normalisation or Nitro's
    // composition changes, this fails rather than invalidation quietly becoming
    // a no-op.
    const root = createStorage()
    root.mount(CACHE_BASE, memoryDriver())

    const suffix = cacheKeySuffix(['2'])
    await root.setItem(nitroEntryKey(CACHE_ENTRY_GROUP, 'catalog', suffix), { value: 'cached' })

    const cache = prefixStorage(root, CACHE_BASE)
    expect(await cache.getItem(cacheEntryKey('catalog', suffix))).toEqual({ value: 'cached' })

    await cache.removeItem(cacheEntryKey('catalog', suffix))
    expect(await root.getItem(nitroEntryKey(CACHE_ENTRY_GROUP, 'catalog', suffix))).toBeNull()
  })

  it('puts every entry of one route under its name prefix', async () => {
    const cache = createStorage()
    await cache.setItem(cacheEntryKey('catalog', cacheKeySuffix(['1'])), 1)
    await cache.setItem(cacheEntryKey('catalog', cacheKeySuffix(['2'])), 1)
    await cache.setItem(cacheEntryKey('catalog-item', cacheKeySuffix(['1'])), 1)

    expect(await cache.getKeys(cacheNamePrefix('catalog'))).toHaveLength(2)
  })
})

describe('tag index keys', () => {
  it('round-trips the entry key it points at', () => {
    const entryKey = cacheEntryKey('catalog', cacheKeySuffix(['2']))
    expect(entryKeyFromIndexKey(tagIndexKey('catalog', entryKey))).toBe(entryKey)
  })

  it('encodes a scoped tag so its colon cannot become a key segment', () => {
    expect(tagIndexPrefix('catalog:42')).toBe('tags:catalog_3a42')
  })

  it('does not let one tag prefix-match a longer sibling', async () => {
    // `getKeys('tags:catalog')` normalises to the base `tags:catalog:`, so
    // `catalog-2` is not swept up with `catalog`. Asserted against a real store
    // because it is unstorage's rule, not this module's.
    const store = createStorage()
    await store.setItem(tagIndexKey('catalog', 'a'), 1)
    await store.setItem(tagIndexKey('catalog-2', 'b'), 1)

    expect(await taggedEntryKeys(store, 'catalog')).toEqual(['a'])
  })
})

describe('normaliseTags', () => {
  it('trims, drops blanks, deduplicates and sorts', () => {
    expect(normaliseTags([' catalog ', 'catalog', '', '   ', 'a'])).toEqual(['a', 'catalog'])
  })

  it('returns an empty list rather than throwing on an empty input', () => {
    expect(normaliseTags([])).toEqual([])
  })
})

describe('registering and invalidating tags', () => {
  let store: ReturnType<typeof createStorage>

  const listPage1 = cacheEntryKey('catalog', cacheKeySuffix(['1']))
  const listPage2 = cacheEntryKey('catalog', cacheKeySuffix(['2']))
  const item4 = cacheEntryKey('catalog-item', cacheKeySuffix(['4']))

  beforeEach(async () => {
    store = createStorage({ driver: memoryDriver() })

    await store.setItem(listPage1, { body: 'page 1' })
    await store.setItem(listPage2, { body: 'page 2' })
    await store.setItem(item4, { body: 'item 4' })

    await registerCacheEntryTags(store, listPage1, ['catalog'])
    await registerCacheEntryTags(store, listPage2, ['catalog'])
    await registerCacheEntryTags(store, item4, ['catalog', 'catalog:4'])
  })

  it('lists the entries indexed under a tag', async () => {
    expect((await taggedEntryKeys(store, 'catalog')).sort()).toEqual(
      [listPage1, listPage2, item4].sort(),
    )
    expect(await taggedEntryKeys(store, 'catalog:4')).toEqual([item4])
  })

  it('drops exactly the entries carrying a narrow tag', async () => {
    const result = await invalidateCacheTags(store, ['catalog:4'])

    expect(result).toEqual({ tags: ['catalog:4'], entries: [item4] })
    expect(await store.getItem(item4)).toBeNull()
    expect(await store.getItem(listPage1)).toEqual({ body: 'page 1' })
  })

  it('drops every entry carrying a broad tag, across routes', async () => {
    const result = await invalidateCacheTags(store, ['catalog'])

    expect([...result.entries].sort()).toEqual([listPage1, listPage2, item4].sort())
    expect(await store.getItem(listPage1)).toBeNull()
    expect(await store.getItem(listPage2)).toBeNull()
    expect(await store.getItem(item4)).toBeNull()
  })

  it('removes an entry once when several of the swept tags name it', async () => {
    const result = await invalidateCacheTags(store, ['catalog', 'catalog:4'])
    expect(result.entries.filter((key) => key === item4)).toHaveLength(1)
  })

  it('removes the index keys it used, so the next sweep does not walk them', async () => {
    await invalidateCacheTags(store, ['catalog:4'])

    expect(await taggedEntryKeys(store, 'catalog:4')).toEqual([])
    // The broad tag still points at it — it was not the tag being swept — which
    // is the "index key for an entry that is gone" case the next sweep tolerates.
    expect(await taggedEntryKeys(store, 'catalog')).toContain(item4)
    expect((await invalidateCacheTags(store, ['catalog'])).entries).toContain(item4)
  })

  it('treats an unknown tag as a no-op, not an error', async () => {
    expect(await invalidateCacheTags(store, ['nothing-cached-here'])).toEqual({
      tags: ['nothing-cached-here'],
      entries: [],
    })
  })

  it('normalises the tags it reports back', async () => {
    const result = await invalidateCacheTags(store, [' catalog:4 ', 'catalog:4', ''])
    expect(result.tags).toEqual(['catalog:4'])
  })

  it('passes a TTL through to the store when the entry has one', async () => {
    const captured: (number | undefined)[] = []
    const spy = {
      ...store,
      setItem: (key: string, value: StorageValue, options?: { ttl?: number }) => {
        captured.push(options?.ttl)
        return store.setItem(key, value, options)
      },
    } as unknown as typeof store

    await registerCacheEntryTags(spy, listPage1, ['ttl-tag'], 30)
    await registerCacheEntryTags(spy, listPage2, ['ttl-tag'])

    // An index key must not outlive its entry silently, and must not expire
    // before it either — see the note on `ttlSeconds` in cached-route.ts.
    expect(captured).toEqual([30, undefined])
  })
})

describe('invalidateCacheName', () => {
  it('drops every entry of one route, tagged or not', async () => {
    const store = createStorage({ driver: memoryDriver() })
    const untagged = cacheEntryKey('catalog', cacheKeySuffix(['3']))

    await store.setItem(cacheEntryKey('catalog', cacheKeySuffix(['1'])), 1)
    await store.setItem(untagged, 1)
    await store.setItem(cacheEntryKey('catalog-item', cacheKeySuffix(['1'])), 1)

    const removed = await invalidateCacheName(store, 'catalog')

    expect(removed).toHaveLength(2)
    expect(await store.getItem(untagged)).toBeNull()
    // The sibling route is a different name, so it is untouched.
    expect(await store.getItem(cacheEntryKey('catalog-item', cacheKeySuffix(['1'])))).toBe(1)
  })

  it('does not reach the tag index, which lives outside the entry group', async () => {
    const store = createStorage({ driver: memoryDriver() })
    await store.setItem(tagIndexKey('catalog', 'app:catalog:index.json'), 1)

    expect(await invalidateCacheName(store, 'catalog')).toEqual([])
    expect(await taggedEntryKeys(store, 'catalog')).toEqual(['app:catalog:index.json'])
  })
})
