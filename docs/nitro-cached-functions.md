# Cached server functions and tag invalidation

`defineCachedEventHandler` stores a route's response in Nitro's `cache` storage
base and serves it again until it goes stale. It is the cheapest performance win
in a Nitro app and it is one option short of usable for anything that changes:
there is no `revalidateTag`, no `revalidatePath`, no way to say "that answer is
wrong now". The only supported way to end a cache early is to wait for `maxAge`.

This app adds the missing half. `server/utils/cached-route.ts` wraps
`defineCachedEventHandler`, and `server/utils/cache-tags.ts` keeps an index from
**tags** to the entries carrying them, so the code that changes the data can drop
exactly the cached responses that were built from it.

| File                            | What it is                                                           |
| ------------------------------- | -------------------------------------------------------------------- |
| `server/utils/cache-tags.ts`    | Keys, encoding, and the tag index. No Nitro dependency; unit-tested. |
| `server/utils/cached-route.ts`  | `defineCachedApiHandler`, and the `useStorage()` / Nitro wiring.     |
| `server/api/cached/`            | The demo routes behind `/cached-functions`.                          |
| `server/utils/cache-schemas.ts` | What the invalidation route accepts as a tag.                        |

## Writing a cached route

```ts
// server/api/cached/catalog.get.ts
export default defineCachedApiHandler(
  {
    name: 'catalog',
    maxAge: 30,
    staleMaxAge: 60,
    key: (event) => [String(getQuery(event)['page'] ?? 1)],
    tags: ['catalog'],
  },
  (event): CatalogPage => readCatalog(event),
)
```

| Option        | Meaning                                                                         |
| ------------- | ------------------------------------------------------------------------------- |
| `name`        | The route's segment in the storage key, and what `invalidateCachedRoute` sweeps |
| `maxAge`      | Seconds before an entry is stale                                                |
| `swr`         | Serve stale while revalidating in the background. Default `true`                |
| `staleMaxAge` | With `swr`, how long a stale entry may still be served                          |
| `key`         | The parts of the request that make two calls different responses                |
| `tags`        | Labels for what this render produced — fixed, or derived from the request       |
| `varies`      | Request headers whose value changes the response                                |

Invalidate from wherever the data changes:

```ts
import { invalidateTags } from '~/server/utils/cached-route'

await invalidateTags(['catalog', `catalog:${id}`])
```

`POST /api/cached/invalidate` is the same call over HTTP, for the demo page and
for callers outside the app (a CMS webhook, a deploy step). It is the one route
under `/api/cached/**` that requires a session — see
[Why the reads are public](#why-the-reads-are-public-and-the-invalidation-is-not).

## Tag shape

A tag is a name, optionally scoped to one record:

- `catalog` — everything derived from the catalog.
- `catalog:42` — one item.

A route usually carries both, so `catalog:42` drops the item without dropping the
list, and `catalog` drops everything in one call. The cost is one storage write
per tag on a cache miss, which is why tags belong on the axes the data actually
changes along, not on every attribute of a response.

## Why the key is built rather than hashed

Deleting a cache entry means calling `removeItem` with the key Nitro wrote it
under, so this only works if that key can be reconstructed. By default it cannot
be: `defineCachedEventHandler` keys an entry on `hash(path)`, and a hash does not
run backwards. Every route here therefore supplies its own `getKey`, built by
`cacheKeySuffix` out of parts the invalidating code can name again.

Two traps sit in Nitro's handling of a custom key, and both are silent.

**`escapeKey` deletes, it does not encode.** The key a route returns is passed
through `String(key).replace(/\W/g, "")`. A key of `page:2` and a key of `page-2`
both come out as `page2`, and two requests that should be separate entries share
one — a cache that serves the wrong page, with nothing in a log to say so.
`encodeKeySegment` is the answer: alphanumerics pass through, everything else
becomes `_` plus the hex of its UTF-8 bytes, so `catalog:42` is `catalog_3a42`.
The result contains only characters `escapeKey` keeps, so escaping is a no-op,
and the encoding is injective — two different inputs cannot produce one key.

**An empty custom key is falsy.** Return `''` and Nitro quietly falls back to its
own path hash. `cacheKeySuffix` returns `_` for a route with no key parts.

The full storage key is what Nitro composes in `defineCachedFunction`:

```
/cache : <group> : <name> : <key>.json
```

With `group: "app"`, that is `cache:app:catalog:1.json` on the root storage, and
`app:catalog:1.json` through `useStorage('cache')`, which is the form every
function in `cache-tags.ts` uses. `tests/unit/server/cache-tags.test.ts` pins
that mapping against a real `unstorage` mount, so a change in either library
fails a test instead of quietly turning invalidation into a no-op.

## `varies` does not work with a custom key

Nitro's `varies` option folds the named request headers into the cache key — but
only on the path where no custom `getKey` was supplied. Its wrapper returns the
custom key immediately and never reaches the header hashing below it. Passing
both therefore looks correct and serves one cached response for every value of
the header: an `accept-language` route answering French out of the English entry.

Every route here has a custom key, so `defineCachedApiHandler` folds the headers
into the key itself. `varies` is still forwarded to Nitro, because it separately
decides which request headers the wrapped handler is allowed to see.

## What the index is, and what it costs

One storage key per (tag, entry) pair, under `tags:` on the same base as the
entries:

```
tags:catalog:app_3acatalog_3a1_2ejson  →  1
```

A set per tag would have to be read, extended and written back, and two handlers
filling different entries under one tag concurrently would lose a write — which
does not corrupt anything, it just leaves an entry that a later invalidation
silently skips. Individual keys have no such window, and reading them back is a
prefix scan (`SCAN MATCH` on Redis).

The index lives on the `cache` base deliberately: it is cache metadata and should
be discarded exactly when the cache is, whether that is `NUXT_REDIS_CACHE_TTL`
expiring keys or an operator flushing the namespace.

Costs, plainly:

- **Cache hit:** nothing. The wrapper's handler does not run at all.
- **Cache miss:** one `setItem` per tag, on top of the render and Nitro's own
  write.
- **Invalidation:** one `getKeys` per tag, then one `removeItem` per entry and
  per index key.

## The limits

Tags are indexed **before** Nitro writes the entry, because there is no hook that
fires after one. Three cases follow, and all three are why
`invalidateCachedRoute(name)` exists:

1. An invalidation landing between the index write and the entry write removes
   the index key for an entry written a moment later. That entry survives until
   `maxAge`.
2. A response Nitro declines to cache — its `validate` rejects any status ≥ 400 —
   still gets index keys. They point at nothing and cost one `removeItem` on the
   next sweep.
3. An entry cached before a tag was added to the route was never indexed under
   it.

All three self-heal within `maxAge`. `invalidateCachedRoute('catalog')` is the
backstop for when that is too long, and the thing to run when a cache needs
emptying outright — it sweeps the `app:<name>` prefix and does not consult the
index at all.

A fourth limit is not the index's fault but is worth knowing: Nitro derives an
entry's `integrity` from a hash of the handler function and its options, so
**every deploy invalidates every entry it changed the code of**. Entries from the
previous build stay in Redis, unreadable, until their own expiry or a prefix
sweep. That is Nitro's design, not this app's, and it is the reason a cache TTL
ceiling (`NUXT_REDIS_CACHE_TTL`) is worth setting on a busy deployment.

Finally: with no `NUXT_REDIS_URL`, the `cache` base is per-process. Invalidation
then only reaches the instance that served the request, which is fine for
`pnpm dev` and a single instance and wrong for anything else. See
`docs/nitro-storage.md`.

## Why the reads are public and the invalidation is not

`server/utils/access-policy.ts` marks `/api/cached/**` public and carves
`/api/cached/invalidate` back out as authenticated.

A cached response is stored once and served to everybody, so a cached route must
not answer differently depending on who asked — the same rule the route-rules
demo endpoints follow. Caching a per-user response under a shared key is how a
cache leaks one user's data to another.

The invalidation route is the opposite kind of thing. It costs a re-render of
everything it touches, so an unauthenticated caller in a loop is a
cache-stampede button: the cache stops absorbing load and every request reaches
the origin. Requiring a session is the cheap half of the fix; rate limiting it is
the other half, and belongs with the app's other rate limiting rather than here.

In a real deployment the caller is usually not a browser at all. It is the code
that just changed the data — a mutation handler, a webhook, a migration — calling
`invalidateTags()` in process.

## Related

- `docs/nitro-route-rules.md` — `swr` / `isr` route rules, which cache whole
  routes declaratively and are the right tool when nothing has to invalidate
  early.
- `docs/nitro-storage.md` — the `cache` base, the Redis driver, and what
  `NUXT_REDIS_CACHE_TTL` does.
- `/cached-functions` — the live demo.
