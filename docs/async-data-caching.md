# Cache keys, `getCachedData`, and payload size

Three problems that look separate and are not. A `useAsyncData` key names a
request; `getCachedData` decides when its answer may be reused; and whatever
that answer contains is serialized into the HTML of every server render. Get the
first wrong and two components share one response. Get the second wrong and the
refresh button stops working. Ignore the third and every visitor downloads the
same JSON twice on first paint.

| File                                | What it is                                                      |
| ----------------------------------- | --------------------------------------------------------------- |
| `utils/asyncDataCache.ts`           | `asyncDataKey`, and the TTL store. No Nuxt import; unit-tested. |
| `utils/payloadBudget.ts`            | Measuring a response and comparing it to a budget.              |
| `composables/useCachedAsyncData.ts` | The wrapper that wires the two into `useAsyncData`.             |
| `pages/async-data-cache.vue`        | The demo behind `/async-data-cache`.                            |

---

## 1. Keys

A key is how Nuxt tells one request from another. Two calls with the same key
share one data ref, one in-flight promise, and one payload entry — which is the
point when they really are the same request, and a bug when they are not.

Hand-built template strings are where that goes wrong:

```ts
// ✗ `posts-1-5` — and `useAsyncData('posts-1-5', …)` somewhere else means
//    something different by it
useAsyncData(`posts-${page.value}-${limit.value}`, fetchPosts)

// ✓ 'posts?limit=5&page=1'
useAsyncData(() => asyncDataKey('posts', { page: page.value, limit: limit.value }), fetchPosts)
```

`asyncDataKey` holds one invariant: **two calls produce the same key exactly
when they would produce the same request.**

Everything else follows from it.

- Parameters are sorted, because argument order is not part of a request.
- `undefined` values and empty arrays are dropped, because neither puts
  anything on the wire.
- `1` and `'1'` give the same key, because a query string carries no types.
- Every segment is percent-encoded, so a parameter named `a&b` cannot be read
  back as two parameters.
- `NaN`, `null`, and objects throw. `Number(query.page)` on a malformed
  parameter is `NaN`, and `page=NaN` is a perfectly good-looking key that every
  malformed request would share.

## 2. `getCachedData`

Nuxt's default is to reuse data on hydration and then never again:

```ts
// nuxt/dist/app/composables/asyncData.js
const getDefaultCachedData = (key, nuxtApp, ctx) => {
  if (nuxtApp.isHydrating) return nuxtApp.payload.data[key]
  if (ctx.cause !== 'refresh:manual' && ctx.cause !== 'refresh:hook')
    return nuxtApp.static.data[key]
}
```

`nuxtApp.static.data` is populated only for routes with payload extraction —
prerendered and cached ones. For everything else the second line finds nothing,
so every later mount refetches: a tab switched away from and back, a list
returning to page 1, a route revisited. That is the right default, and the wrong
one for data that is expensive and barely changes.

`useCachedAsyncData` supplies a TTL instead:

```ts
const { data, cacheStatus, payload } = useCachedAsyncData(
  () => asyncDataKey('posts', { page: page.value }),
  () => $fetch('/api/posts', { params: { page: page.value } }),
  { ttlMs: 60_000 },
)
```

### Three things that are easy to get wrong

**The `cause` is load-bearing.** Nuxt's `granularCachedData` defaults to
**true**, so `getCachedData` is consulted on `refresh()` and on
`refreshNuxtData()` as well as on the initial load. A TTL cache that ignores
`cause` answers those from the store — which silently turns every refresh button
in the app into a no-op for the length of the TTL, with no error anywhere.
`useCachedAsyncData` answers `initial` and `watch` only.

**Hydration still comes from the payload.** The store is empty in a
freshly-loaded browser, so a naive implementation misses on the first client
resolution and refetches everything the server already fetched — strictly worse
than not caching. The hydration branch returns `nuxtApp.payload.data[key]`, as
the default does, and seeds the store with it so the _next_ navigation is a hit.

**Supplying `getCachedData` turns off Nuxt's cleanup.** The `purgeCachedData`
sweep skips any key with a custom `getCachedData`:

```js
if (purgeCachedData && !hasCustomGetCachedData) nextTick(() => { … })
```

So from the moment you pass one, `nuxtApp.payload.data[key]` and the entry here
both outlive the component that asked for them. That is why `maxEntries` (50 by
default) is a cap and not advice, and why `invalidate()` is part of the return
value.

### What is not cached, and where the cache lives

The store hangs off the NuxtApp, and Nuxt builds one of those per render on the
server. A server-side hit is therefore impossible by construction — the same
reasoning as [`composable-design-rules.md`](./composable-design-rules.md), where
a module-scope `Map` is one visitor's data in another visitor's page. This is a
client-side navigation optimisation. For an actual server cache, shared across
requests and invalidated by tag, see
[`nitro-cached-functions.md`](./nitro-cached-functions.md).

One store serves every key in an app, so its TTL and cap are settled by
whichever call site ran first, and later ones can only widen them. Per-key TTLs
would be the alternative; they are not worth the bookkeeping for a cache this
short-lived.

### Return value

Alongside everything `useAsyncData` returns:

| Field             | What it is                                                             |
| ----------------- | ---------------------------------------------------------------------- |
| `cacheStatus`     | `idle`, `hit`, `miss`, `expired`, `bypass`, or `hydration`             |
| `cacheKey`        | The key currently in use — the resolved value when the key is a getter |
| `payload`         | The last fetch's budget report, or `null`                              |
| `invalidate()`    | Drops this key, so the next resolution fetches                         |
| `cacheSnapshot()` | Everything the store holds, for a debug panel                          |

Like `usePollingData`, the return is a plain object rather than the thenable
`useAsyncData` hands back, so it cannot be `await`ed directly. Await `refresh()`.

## 3. Payload size

Everything `useAsyncData` resolves on the server is written to
`nuxtApp.payload.data[key]` and serialized into the document, so the browser
downloads each response twice: once as rendered markup, once again as JSON in
`__NUXT__`. The second copy has no network-panel entry, no warning, and no build
error, and it is paid on first paint, before hydration, on whatever connection
the visitor has.

The fix is `pick` or `transform`, both of which run before Nuxt stores the
value:

```ts
useCachedAsyncData<PaginatedResponse<Post>, PostSummary[]>('posts', () => $fetch('/api/posts'), {
  transform: (response) => response.data.map(({ id, title }) => ({ id, title })),
})
```

The point of measuring is that nothing else in the toolchain tells you when you
have stopped doing it. Every fetch is measured against `payloadBudgetBytes`
(16 kB by default); going over warns in dev and is reported through `payload`,
naming the largest fields so the warning says which one to drop:

```
[payload] "posts" serializes to 41.3 kB, over its 16.0 kB budget. Every byte is
sent twice on an SSR render — once as HTML, once in the __NUXT__ payload.
Largest fields: data (40.9 kB), pagination (61 B). Narrow it with `pick` or
`transform`.
```

The measurement is `JSON.stringify` plus a UTF-8 byte count. Nuxt serializes
with devalue, which handles cycles and a few types JSON drops, so this is a
close estimate rather than the exact byte count — near enough to notice a
response that doubled, which is what a budget is for. A value with no JSON form
measures as `null` and is never reported as over budget; a budget check is not
the place to find out that something will not serialize.

Nothing here changes what is fetched or stored. The budget is a signal, not a
gate.
