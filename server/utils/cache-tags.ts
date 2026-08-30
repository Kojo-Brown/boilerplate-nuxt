import type { Storage } from 'unstorage'

/**
 * Cache-tag bookkeeping for `defineCachedEventHandler` — the part Nitro does not
 * have.
 *
 * Nitro can cache a handler's response (`maxAge`, `swr`, `staleMaxAge`) but it
 * has exactly one way to end that cache early: wait for it to expire. There is
 * no `revalidateTag`. When a POST changes the data three cached endpoints are
 * built from, the only supported answer is "the stale copy is served for up to
 * `maxAge` seconds". This module is the answer for the cases where that is not
 * good enough.
 *
 * A **tag** is a label a cached route attaches to whatever it just rendered
 * (`catalog`, `catalog:42`). Invalidating a tag deletes every cache entry
 * carrying it, so the next request re-renders. Everything here operates on an
 * injected {@link Storage} so it is testable against a real in-memory store;
 * `server/utils/cached-route.ts` is the layer that binds it to Nitro's own
 * `cache` base and to `defineCachedEventHandler`.
 *
 * ## Why this needs to reconstruct Nitro's storage key
 *
 * Deleting a cache entry means calling `removeItem` with the key Nitro wrote it
 * under. Nitro composes that key in `defineCachedFunction`
 * (`nitropack/dist/runtime/internal/cache.mjs`, 2.13.4) as:
 *
 * ```js
 * [opts.base, group, name, key + ".json"].filter(Boolean).join(":").replace(/:\/$/, ":index")
 * ```
 *
 * with `base` defaulting to `/cache` and `group` to `nitro/handlers`, and reads
 * and writes it on the **root** storage. unstorage's `normalizeKey` turns the
 * leading `/cache:` into the `cache:` mount, so an entry this app writes under
 * group {@link CACHE_ENTRY_GROUP} lands at `cache:app:<name>:<key>.json` on the
 * root and at `app:<name>:<key>.json` on `useStorage('cache')` — which is the
 * form every function here uses. `tests/unit/server/cache-tags.test.ts` pins
 * that mapping against a real `prefixStorage`, so a change in either library
 * fails a test rather than silently making invalidation a no-op.
 *
 * ## Why the key has to be built, not hashed
 *
 * By default `defineCachedEventHandler` keys an entry on `hash(path)`. A hash is
 * a one-way function: given "the catalog changed", there is no way to work back
 * to the keys that need deleting. So every route cached through this module
 * supplies its own key, built from {@link cacheKeySuffix} out of parts the route
 * can name again later.
 *
 * Two traps make that less obvious than it sounds, both in Nitro's wrapper
 * around a custom `getKey`:
 *
 *  1. The returned key is passed through `escapeKey`, which is
 *     `String(key).replace(/\W/g, "")` — it **deletes** every character outside
 *     `[A-Za-z0-9_]` rather than encoding it. A key of `page:2` and a key of
 *     `page-2` both become `page2`, and two different requests quietly share one
 *     cache entry. {@link encodeKeySegment} is why that cannot happen here: it
 *     emits only characters `escapeKey` keeps, so escaping is a no-op.
 *  2. A custom `getKey` that returns an empty string is falsy, so Nitro silently
 *     falls back to its default path hash — an unpredictable key again.
 *     {@link cacheKeySuffix} returns {@link EMPTY_KEY_SUFFIX} rather than `''`
 *     for that reason.
 */

/**
 * The `group` segment for every entry this app caches.
 *
 * Nitro's own default is `nitro/handlers`, which is also where route rules put
 * their entries. Taking a distinct group keeps the two apart: a prefix sweep of
 * `app:` can never delete a route-rule cache, and `getKeys('app')` in a debug
 * session lists exactly the entries this module manages.
 */
export const CACHE_ENTRY_GROUP = 'app'

/**
 * The prefix the tag index lives under, on the same base as the entries it
 * points at.
 *
 * Sharing the base is deliberate. The index is cache metadata: it should be
 * discarded exactly when the cache is, whether that is `NUXT_REDIS_CACHE_TTL`
 * expiring keys or an operator flushing the namespace. A separate base would
 * survive a cache flush and leave the index describing entries that no longer
 * exist.
 *
 * It is not a group, so an index key can never collide with an entry key: entry
 * keys always end in `.json` under `app:`, index keys always sit under `tags:`.
 */
export const TAG_INDEX_GROUP = 'tags'

/** Cache-entry names are a path segment, so they are constrained rather than encoded. */
const CACHE_NAME_PATTERN = /^[a-z][a-z0-9-]*$/

/** Two encoded segments joined. See {@link cacheKeySuffix} for why it is safe. */
const KEY_PART_SEPARATOR = '__'

/**
 * The key of a route whose parts encode to nothing at all. A bare `_` is
 * unreachable for any other part list — see {@link cacheKeySuffix}.
 */
export const EMPTY_KEY_SUFFIX = '_'

/** One escape produced by {@link encodeKeySegment}: `_` and two lowercase hex digits. */
const ESCAPE_PATTERN = /^_[\da-f]{2}$/

/**
 * Everything `server/utils/cached-route.ts` resolves for one request before
 * Nitro decides whether it is a hit.
 *
 * It lives here, in the module with no Nitro dependency, so `server/types/h3.d.ts`
 * can put it on `H3EventContext` without the type file reaching into a module
 * that calls auto-imports.
 */
export interface CachedEntryContext {
  /** The `key` segment, already in the alphabet Nitro's `escapeKey` leaves alone. */
  readonly keySuffix: string
  /** Storage key of the entry, relative to the `cache` base. */
  readonly entryKey: string
  /** Tags to index it under, normalised. */
  readonly tags: readonly string[]
  /** Entry lifetime in seconds, or `undefined` when it has none. */
  readonly ttlSeconds: number | undefined
}

/** What a route asks to be invalidated, and what actually was. */
export interface TagInvalidation {
  /** The tags that were swept, normalised. */
  readonly tags: readonly string[]
  /** Cache entry keys removed, relative to the `cache` base. Deduplicated. */
  readonly entries: readonly string[]
}

/**
 * Encodes an arbitrary string into `[A-Za-z0-9_]`, the alphabet Nitro's
 * `escapeKey` leaves alone.
 *
 * Alphanumerics pass through; every other character becomes `_` followed by the
 * lowercase hex of each of its UTF-8 bytes, so `catalog:42` is `catalog_3a42`
 * and `é` is `_c3_a9`. That makes the encoding **injective** — the property the
 * whole module rests on, since two requests that encode to one key share a cache
 * entry — and reversible, so a key read back out of storage can still be read by
 * a human. It is not a hash: nothing is lost, and nothing collides.
 *
 * The cost is length. A UUID encodes to 40 characters rather than 36, and a long
 * query string to roughly three times its size. Cache keys are not a scarce
 * resource; a silent collision is not a trade worth making to shorten them.
 */
export function encodeKeySegment(value: string): string {
  let out = ''

  for (const char of value) {
    if (/^[A-Za-z\d]$/.test(char)) {
      out += char
      continue
    }
    for (const byte of new TextEncoder().encode(char)) {
      out += `_${byte.toString(16).padStart(2, '0')}`
    }
  }

  return out
}

/**
 * Reverses {@link encodeKeySegment}.
 *
 * Consecutive escapes are collected before decoding, because one character can
 * be several UTF-8 bytes and decoding them one at a time would produce
 * replacement characters instead of the original.
 *
 * A `_` that is not followed by two lowercase hex digits cannot come from the
 * encoder, so it is passed through as a literal rather than treated as an error:
 * this is used to read keys back out of a shared store, and a foreign key should
 * be legible, not fatal.
 */
export function decodeKeySegment(value: string): string {
  const decoder = new TextDecoder()
  const bytes: number[] = []
  let out = ''

  const flush = (): void => {
    if (bytes.length === 0) return
    out += decoder.decode(Uint8Array.from(bytes))
    bytes.length = 0
  }

  for (let i = 0; i < value.length;) {
    const escape = value.slice(i, i + 3)
    if (ESCAPE_PATTERN.test(escape)) {
      bytes.push(Number.parseInt(escape.slice(1), 16))
      i += 3
      continue
    }
    flush()
    out += value[i]
    i += 1
  }

  flush()
  return out
}

/**
 * Builds the `key` segment Nitro appends to the entry key, from the parts that
 * make two requests different responses.
 *
 * Parts are encoded individually and joined with `__`. That separator is
 * unambiguous because an encoded part can never contain it: every `_` in an
 * encoded part is the start of an escape and is followed by two hex digits.
 * Joining with a single `_` would not be — `['a', '5f']` and `['a_']` would both
 * produce `a_5f` — and joining without one would merge `['ab','c']` into
 * `['a','bc']`. So the mapping from parts to suffix is injective, which is the
 * property that stops two different requests sharing a cache entry.
 *
 * The one case that needs a sentinel is a suffix that would come out **empty**:
 * a route with no key parts, and the degenerate `['']`. It cannot be the empty
 * string, because Nitro tests a custom key for truthiness and falls back to its
 * own path hash when it is falsy — an unpredictable key, and an entry no
 * invalidation could find. Both produce {@link EMPTY_KEY_SUFFIX} instead, which
 * no other part list can produce: a non-empty join either starts with an
 * alphanumeric or with a full three-character escape. Those two collapsing
 * together is the only collision in the scheme, and they mean the same thing —
 * nothing about this request distinguishes it.
 */
export function cacheKeySuffix(parts: readonly string[]): string {
  const joined = parts.map(encodeKeySegment).join(KEY_PART_SEPARATOR)
  return joined === '' ? EMPTY_KEY_SUFFIX : joined
}

/**
 * Throws unless `name` is usable as a cache-entry name.
 *
 * Unlike the key, the name is **not** escaped by Nitro — it is interpolated into
 * the storage key as-is, so a `/` in it would silently become another `:`
 * segment and a `?` would truncate the key at `normalizeKey`. Constraining it is
 * simpler than encoding it, and keeps `getKeys('app:catalog')` readable.
 */
export function assertCacheName(name: string): void {
  if (!CACHE_NAME_PATTERN.test(name)) {
    throw new Error(
      `Invalid cache name "${name}". Expected lowercase letters, digits and ` +
        'hyphens, starting with a letter — it is written into the storage key verbatim.',
    )
  }
}

/**
 * The storage key of one cache entry, relative to the `cache` base.
 *
 * Mirrors Nitro's own composition (see the note at the top of this file). The
 * `.json` suffix is Nitro's, not a serialisation choice of ours.
 */
export function cacheEntryKey(name: string, keySuffix: string): string {
  assertCacheName(name)
  return `${CACHE_ENTRY_GROUP}:${name}:${keySuffix}.json`
}

/** The prefix every entry of one cached route shares — the argument to `getKeys()`. */
export function cacheNamePrefix(name: string): string {
  assertCacheName(name)
  return `${CACHE_ENTRY_GROUP}:${name}`
}

/** The prefix every index key for one tag shares. */
export function tagIndexPrefix(tag: string): string {
  return `${TAG_INDEX_GROUP}:${encodeKeySegment(tag)}`
}

/** `tags:<tag>:<entry key>`, both encoded so neither can escape its segment. */
export function tagIndexKey(tag: string, entryKey: string): string {
  return `${tagIndexPrefix(tag)}:${encodeKeySegment(entryKey)}`
}

/** Reads the entry key back out of an index key produced by {@link tagIndexKey}. */
export function entryKeyFromIndexKey(indexKey: string): string {
  const encoded = indexKey.slice(indexKey.lastIndexOf(':') + 1)
  return decodeKeySegment(encoded)
}

/**
 * Cleans a tag list: trimmed, non-empty, deduplicated, sorted.
 *
 * Sorting is not cosmetic — an invalidation response lists what it swept, and a
 * stable order makes that assertable. Empty and whitespace-only tags are dropped
 * rather than rejected: they come from user input on the invalidation route,
 * where the meaningful error is "nothing to invalidate", raised once by the
 * caller, not one error per blank string.
 */
export function normaliseTags(tags: readonly string[]): string[] {
  return [...new Set(tags.map((tag) => tag.trim()).filter((tag) => tag !== ''))].sort()
}

/**
 * Records that `entryKey` carries each of `tags`.
 *
 * One key per (tag, entry) pair rather than one set per tag. A set would have to
 * be read, extended and written back, and two handlers filling different cache
 * entries under the same tag concurrently would lose one of the two writes —
 * which does not corrupt anything, it just leaves an entry that a later
 * invalidation silently skips. Individual keys have no such window, and reading
 * them back is a prefix scan the store already supports (`SCAN MATCH` on Redis).
 *
 * The value is a constant; everything this needs to say is in the key.
 *
 * `ttlSeconds` should be the lifetime of the entry itself, or omitted when the
 * entry has none. An index key that expires before its entry would make that
 * entry uninvalidatable — {@link invalidateCacheName} is the backstop for that,
 * and for anything else that leaves an entry unindexed.
 */
export async function registerCacheEntryTags(
  store: Storage,
  entryKey: string,
  tags: readonly string[],
  ttlSeconds?: number,
): Promise<void> {
  const options = ttlSeconds === undefined ? undefined : { ttl: ttlSeconds }

  await Promise.all(
    normaliseTags(tags).map((tag) => store.setItem(tagIndexKey(tag, entryKey), 1, options)),
  )
}

/** The cache entries currently indexed under one tag. */
export async function taggedEntryKeys(store: Storage, tag: string): Promise<string[]> {
  const indexKeys = await store.getKeys(tagIndexPrefix(tag))
  return indexKeys.map(entryKeyFromIndexKey)
}

/**
 * Deletes every cache entry carrying any of `tags`, and the index keys that
 * pointed at them.
 *
 * Entries are collected across all tags before anything is removed, so an entry
 * carrying two of the tags being swept is deleted once. The index keys go too:
 * leaving them would make the next sweep of the same tag walk keys whose entries
 * are already gone, and on a long-lived tag like `catalog` that list only grows.
 *
 * A `removeItem` for an entry that is not there is not an error — it is the
 * normal outcome when the entry expired on its own, or when it was written
 * before this app started tagging. Nothing here treats a miss as a failure, and
 * the returned {@link TagInvalidation} reports what was swept, not what was
 * found: "how many keys existed" is a fact about cache warmth, and a caller that
 * branched on it would be branching on chance.
 */
export async function invalidateCacheTags(
  store: Storage,
  tags: readonly string[],
): Promise<TagInvalidation> {
  const normalised = normaliseTags(tags)
  const entries = new Set<string>()
  const indexKeys: string[] = []

  for (const tag of normalised) {
    for (const indexKey of await store.getKeys(tagIndexPrefix(tag))) {
      indexKeys.push(indexKey)
      entries.add(entryKeyFromIndexKey(indexKey))
    }
  }

  await Promise.all([...entries].map((key) => store.removeItem(key)))
  await Promise.all(indexKeys.map((key) => store.removeItem(key)))

  return { tags: normalised, entries: [...entries].sort() }
}

/**
 * Deletes every cache entry of one route, tagged or not — the backstop for the
 * cases the tag index cannot cover.
 *
 * There are three, and they are the honest limits of this design:
 *
 *  - An entry whose index write failed (see `server/utils/cached-route.ts`,
 *    which logs and carries on rather than failing the request).
 *  - An entry written between an invalidation reading the index and the sweep
 *    finishing. Its index key is removed by that sweep, so the entry it
 *    describes outlives the invalidation that should have caught it.
 *  - An entry cached before a tag was added to the route.
 *
 * All three self-heal within `maxAge`. This is what to reach for when that is
 * too long, and what an operator runs when a cache needs to be emptied outright.
 * It does not touch the tag index — the keys there expire with the entries or
 * are cleared by the next sweep of their tag.
 */
export async function invalidateCacheName(store: Storage, name: string): Promise<string[]> {
  const keys = await store.getKeys(cacheNamePrefix(name))
  await Promise.all(keys.map((key) => store.removeItem(key)))
  return keys.sort()
}
