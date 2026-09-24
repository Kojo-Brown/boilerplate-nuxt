# boilerplate-nuxt

> Nuxt 4.4 · TypeScript 6 · TailwindCSS 4 · Pinia · Drizzle ORM

Full-stack Nuxt starter with server-side rendering, auth, and a database-first approach.

## Stack

| Layer     | Tech                     |
| --------- | ------------------------ |
| Framework | Nuxt 4.4                 |
| Language  | TypeScript 6             |
| Styles    | TailwindCSS 4            |
| State     | Pinia                    |
| Database  | Drizzle ORM + PostgreSQL |
| Auth      | nuxt-auth-utils          |
| i18n      | @nuxtjs/i18n             |
| Images    | @nuxt/image + IPX        |
| Testing   | Vitest + Playwright      |

## Requirements

- **Node.js `^22.19.0 || ^24.11.0`** — the two active LTS lines, and the floor
  Nuxt 4.5 itself declares. `.npmrc` sets `engine-strict=true`, so `pnpm install`
  refuses to run on anything else instead of failing later in the build.
- **pnpm 10** — pinned via the `packageManager` field, so Corepack and
  `pnpm/action-setup` both resolve the same version CI uses.

## Quick Start

```bash
git clone https://github.com/Kojo-Brown/boilerplate-nuxt.git
cd boilerplate-nuxt
pnpm install
cp .env.example .env
pnpm dev  # http://localhost:3000
```

## CI

Every gate — lint, format, typecheck, unit tests, build — runs on both supported
Node majors, and warnings are failures rather than log noise:

| Gate      | Warning-as-error mechanism                         |
| --------- | -------------------------------------------------- |
| install   | `--strict-peer-dependencies`, `engine-strict=true` |
| lint      | `eslint --max-warnings=0`                          |
| all steps | `NODE_OPTIONS=--throw-deprecation`                 |

Approved build scripts are listed in `pnpm.onlyBuiltDependencies`; anything not
listed makes `pnpm install` print an "ignored build scripts" warning, which is
why that list exists rather than being left to the default.

## Composable Lifetimes

Effects — `watch`, `watchEffect`, `computed` — belong to whatever scope is
active when they are created, and a component's scope is disposed on unmount.
That default is wrong at both ends, and `effectScope` fixes both. Live demo:
`/effect-scope`.

**State that must outlive the component that asked for it first.** A shared
composable written as a module-level `ref` plus a `watch` created on first use
gives the watcher to whichever component mounted first — it dies when _that_
one unmounts, while others are still reading — and nothing releases it when
they all leave. `createSharedComposable` (`utils/sharedComposable.ts`) runs the
factory inside a detached scope and reference-counts consumers, so the group is
built on the first subscribe and stopped on the last release:

```ts
export const useSessionClock = createSharedComposable(() => {
  const now = ref(Date.now())
  const id = setInterval(() => (now.value = Date.now()), 1_000)
  onScopeDispose(() => clearInterval(id)) // last consumer out, not the first
  return { now: readonly(now) }
})
```

**Effects that must not outlive the selection that created them.** Watching a
selected document or subscribing to a room means tearing effects down several
times while one component stays mounted; the component scope will not do that
for you, and keeping every `stop()` handle by hand rots the moment someone adds
an effect. `useScopedEffects()` (`composables/useScopedEffects.ts`) gives the
group one handle:

```ts
const selection = useScopedEffects()

watch(documentId, (id) => {
  selection.run(() => {
    watch(draft, save) // stopped by the next run()
    const socket = subscribe(id)
    onScopeDispose(() => socket.close()) // and so is the socket
  })
})
```

Both bind teardown explicitly rather than relying on ambient ownership, because
`run()` is typically called from an event handler or a watcher callback, where
the active scope is either nothing or the wrong one.

## Deferred Refs

`customRef` hands you `track` and `trigger`, which lets a ref separate _when a
value is written_ from _when its readers are told_. Putting the delay in the
value rather than in the handler means every consumer inherits it — including
consumers written later that know nothing about it — and the ref stays a plain
`Ref<T>`, so `v-model`, `watch`, and `computed` are unchanged. Live demo:
`/custom-ref`.

**Debounce — publish once the writes stop.** `useDebouncedRef()`
(`composables/useDebouncedRef.ts`) for search boxes, filter panels, autosave:
anything where only the settled value is worth acting on.

```ts
const query = useDebouncedRef('', 300, { maxWait: 2_000 })
const { pending, flush } = query

// Fires once per pause in typing, not once per keystroke.
watch(query, (q) => search(q))
```

`maxWait` is not optional in spirit: without it, someone typing steadily faster
than `delay` never triggers a search at all.

**Throttle — publish at a bounded rate.** `useThrottledRef()`
(`composables/useThrottledRef.ts`) for scroll offsets, drag positions, live
cursors: anything where the values in the middle of a burst are the point.
Debouncing those shows nothing until the user stops moving.

```ts
const scrollY = useThrottledRef(0, 100) // ~10 commits/s, not ~60
```

Both return a `DeferredRef<T>` — a ref with `draft` (the latest write, whether
or not it has landed), `pending`, `flush()`, and `cancel()`. Those are
properties _on_ the ref, so in a template, where a top-level ref is
auto-unwrapped, destructure first:

```ts
const { pending, flush } = query // `query.pending` in a template is undefined
```

Both write through instead of deferring during SSR. A render pass resolves
before any `setTimeout` fires, so a deferred write on the server is not delayed,
it is lost — and the markup would then disagree with the client after hydration.

## Reactivity Pitfalls

Vue never tells you that a reactive binding was severed. `count` is a `number`
whether it came off a live proxy or off a destructure that killed it three lines
earlier; the view just renders once and then stops, far from the line at fault.

[**docs/reactivity-pitfalls.md**](./docs/reactivity-pitfalls.md) is the guide —
destructuring loss, `toRefs` vs `toRef`, and the deep-vs-shallow trade — and
every claim in it is asserted in `tests/unit/reactivity-pitfalls.test.ts`, so a
Vue upgrade that changes one of those semantics fails CI on the line that
documents it rather than in a bug report. Live demo: `/reactivity-pitfalls`.

The three that cost the most time:

```ts
const { count } = state // dead copy — `toRefs(state)` keeps it bound
toRefs(state).page // undefined if `page` arrived later — `toRef(state, 'page')` does not care
computed(() => shallowSource.value.n) // caches a *wrong* answer, not a late one
```

When you are unsure what a value actually is, `utils/reactivityInspect.ts`
classifies it without reading through it, so calling it inside an effect adds no
dependency:

```ts
formatReactivity(state) // 'reactive (deep)'
formatReactivity(count) // 'plain (not tracked)'  ← the bug

assertTracked(state, 'useFilters(state)') // throws at the boundary instead
```

## Composable Design Rules

On the server a module is evaluated once per _process_, not once per request, and
Nuxt auto-imports `composables/`, `utils/`, and `stores/` into every render. So
module scope is process scope: state held there is shared by every visitor, and
work done there runs before any request exists.

[**docs/composable-design-rules.md**](./docs/composable-design-rules.md) is the
guide — no side effects on import, injectable dependencies, SSR-safe state — and
two of the three are gates rather than advice:

```ts
const toasts = ref<Toast[]>([]) // ✗ lint: one array for the whole process
setInterval(refresh, 30_000) // ✗ lint: runs on import, once, for everyone
const LEVELS = ['info', 'error'] as const // ✓ readonly, so sharing it is safe

export function useToast(deps: Partial<ToastDeps> = {}) {
  const toasts = useState<Toast[]>('app:toasts', () => []) // ✓ one per request
}
```

`eslint-rules/composable-design.mjs` supplies the two rules and runs as part of
`pnpm lint`; `tests/unit/composables/import-purity.test.ts` covers what a linter
cannot see, importing every module in those directories with timers, `fetch`,
listeners, and `console` instrumented and failing if any of them fires.

Dependencies that are awkward to test — clocks, randomness, timers, transports —
are taken as an optional argument that defaults to the real thing, so
application code calls `useToast()` unchanged and a test injects only what it
cares about:

```ts
const { schedule, advance } = createFakeScheduler()
const { addToast, toasts } = useToast({ schedule }) // real clock, fake timer
```

## provide / inject and Dependency Inversion

A component that calls `$fetch('/api/todos')` depends on the network, so it only
runs where the network, a database, and a session all exist. Behind a port it
depends on an interface instead, and an ancestor decides which implementation
that is.

[**docs/provide-inject.md**](./docs/provide-inject.md) is the guide. `types/todos.ts`
declares the `TodoGateway` port, `utils/todoGateway.ts` holds the adapters —
in-memory, HTTP, and a decorator that makes chosen operations fail — and
`composables/useTodoList.ts` depends on the port and nothing else. Live demo:
`/dependency-inversion`, which swaps the adapter under a running UI.

`defineInjection` in `utils/injection.ts` types both ends of the wiring from one
`InjectionKey`, and fails loudly where Vue returns `undefined`:

```ts
export const todoGatewayInjection = defineInjection<TodoGateway>('todos.gateway')

todoGatewayInjection.provide(createInMemoryTodoGateway()) // rejects anything else
const gateway = todoGatewayInjection.inject() // TodoGateway, or a named throw
todoGatewayInjection.provideTo(nuxtApp.vueApp, gateway) // app-wide: per request
```

What the seam buys is visible in the suite: `useTodoList` is covered through
loading, adding, toggling, deleting, four failure paths and an out-of-order
refresh with no `$fetch` stub, no database, and mostly no component — the test
passes a gateway in.

## Render Functions and JSX

A template describes a fixed tree. A table whose columns arrive as data has no
fixed tree: every `<th>` and `<td>` comes from mapping an array, and each cell
picks its content from a slot whose _name is computed_ — `cell:<column id>`.
That is what a render function is for.

[**docs/render-functions.md**](./docs/render-functions.md) is the guide, and is
as much about when to keep the template as when not to.
`components/DataTable.tsx` is the table, `utils/dataTable.ts` is its model —
column definitions, the three-state sort toggle, a stable sort — and
`pages/render-functions.vue` drives both, toggling columns on and off under a
component that never named one. The whole per-cell decision is one expression:

```tsx
const slot = slots[`cell:${column.id}`]
return <td>{slot ? slot({ row, rowIndex, column, text }) : text}</td>
```

`components/DataTableSection.tsx` is the wrapper, and the reason
`utils/slots.ts` exists. It renders a heading and a row count, and forwards
every other slot to the table below without naming any of them:

```tsx
h(DataTable<Row>, tableProps, forwardSlots(slots, { except: ['title'] }))
```

`forwardSlots` returns a proxy rather than a spread, because `ctx.slots` is not
a snapshot — a parent whose slot sits behind a `v-if` adds the key after the
first render, and a copy taken in `setup()` would never see it.

Getting the row type all the way to `#cell:status="{ row }"` takes three
deliberate choices, each documented in the guide: the components are plain
functional components (`defineComponent` erases the type parameter), their
runtime prop declarations are name lists (an object declaration pins it), and
each consumer binds it once with `const InvoiceSection = DataTableSection<Invoice>`.

## Server middleware and request-scoped auth

`middleware/auth.global.ts` is a router guard: it turns a protected navigation
into a redirect to `/login`. It ships in the client bundle and `curl` never runs
it, so until this item every route under `server/api/` answered anyone who asked.

[**docs/server-middleware.md**](./docs/server-middleware.md) is the guide.
`server/utils/access-policy.ts` is a **default-deny** table — `/api/**` requires
a session and every public route is an explicit carve-out with a reason —
enforced by `server/middleware/10.auth.ts`, which resolves the session once per
request onto a typed `event.context.auth`:

```ts
export default defineEventHandler(async (event) => {
  const { user } = requireAuth(event)
  //      ^? User — not User | undefined, no `!`, no cast
})
```

`RequestAuth` is a discriminated union, so `requireAuth` narrows by throwing:
401 when the caller has no session, 500 (naming the policy file) when no
middleware ever resolved one — the same trade `defineInjection` makes on the app
side. `server/types/h3.d.ts` augments `H3EventContext` so `requestId`,
`requestReceivedAt` and `auth` stop being `any`.

Two things that come with turning the gate on, both documented in the guide: the
policy matches a **normalised** pathname, because
`/api/route-rules/%2e%2e/todos` otherwise reads as public and resolves as
protected; and a page reading a protected route during SSR needs
`useRequestFetch()`, since plain `$fetch` sends no cookies and `useAsyncData`
turns the resulting 401 into a silently dataless 200.

## Cache keys, `getCachedData`, and payload size

Nuxt reuses `useAsyncData` results on hydration and then never again, so every
later mount refetches — a tab switched away from and back, a list returning to
page 1. `useCachedAsyncData` adds a TTL to that, and the two things it takes to
do safely.

[**docs/async-data-caching.md**](./docs/async-data-caching.md) is the guide;
`/async-data-cache` is the demo.

```ts
const { data, cacheStatus, payload } = useCachedAsyncData(
  () => asyncDataKey('posts', { page: page.value, limit: limit.value }),
  () => requestFetch('/api/posts', { params: { page: page.value, limit: limit.value } }),
  { ttlMs: 60_000 },
)
```

`asyncDataKey` holds one invariant — two calls produce the same key exactly when
they would produce the same request — which is what a hand-built
`` `posts-${page}-${limit}` `` does not, and why two components can end up
sharing one data ref.

Three things the wrapper exists to get right, each of which fails silently
otherwise. Nuxt's `granularCachedData` defaults to **true**, so `getCachedData`
is consulted on `refresh()` too: a TTL cache that ignores the `cause` turns
every refresh button in the app into a no-op. Hydration must still come from
`nuxtApp.payload.data`, or a cached page fetches everything twice on first load.
And supplying `getCachedData` at all switches off Nuxt's `purgeCachedData`
sweep for that key, so `maxEntries` is the only thing bounding what the app
holds.

The third piece is the payload itself: everything resolved on the server is
serialized into the document as well as rendered, so each response is downloaded
twice on first paint with no network-panel entry for the second copy. Every
resolution is measured against a budget and names its largest fields when it
goes over — `transform` takes the demo's own list from 3.34 kB to 683 B.

## Server Islands

A component in `components/islands/` renders on the server and is delivered as
HTML. Its code is compiled into the server bundle and into **no client chunk**,
so the browser gets the markup and never the component that produced it — the
right trade for content, which has no state to hydrate and no handlers to bind.

[**docs/server-islands.md**](./docs/server-islands.md) is the guide; `/islands`
is the demo, and it renders its own explanation through the mechanism it is
explaining.

```vue
<NuxtIsland name="ContentSection" :props="{ slug }" />
```

The markup renderer behind those sections (`server/utils/content-markup.ts`) is
the code that stays put: ~10 kB of island components and styles compile into
`.output/server/chunks/` and into nothing under `.output/public/_nuxt/`.

Three things the guide is there to get right. **Island markup is inert** — a
`@click` inside one never fires and `onMounted` never runs, with no warning
anywhere, so `tests/unit/islands.test.ts` scans the directory for both. **Props
are a cache key**: they are JSON-serialised into the island's URL, which makes
them public, logged, and one cache entry per distinct value — `inspectIslandProps()`
reports what serialisation will do to them before they are sent. And **`lazy`
defers a navigation, not a first paint**: on a full page load a lazy island is
server-rendered and inlined like any other, which is the opposite of what the
name suggests.

## Core Web Vitals

Lighthouse measures one load on one machine. The number a site is assessed on is
field data: real visitors, at p75. The browser collects LCP, CLS, INP, FCP and
TTFB, batches them, and beacons them to `/api/vitals`, which forwards each batch
to whatever `NUXT_VITALS_SINK_URL` points at.

[**docs/web-vitals.md**](./docs/web-vitals.md) is the guide.

```sh
curl -s localhost:3000/api/vitals -H 'content-type: application/json' -d '…'
# {"accepted":1,"sinks":["aggregate","log"]}
```

Three things the guide is there to get right. **No vital is final until the page
is going away** — CLS accumulates for the life of the page and INP can only get
worse — so the flush happens on `visibilitychange` → hidden and on `pagehide`,
never on `unload`, which mobile Safari does not fire and which disqualifies the
page from the bfcache just by being listened for. That leaves
`navigator.sendBeacon` as the only send that survives the document, and a beacon
carries no headers, which is why **`/api/vitals` is public** and why its schema
is closed enums and bounded everything. And **unconfigured is a supported mode**:
with no sink URL the batches land in a bounded in-process window that
`GET /api/vitals/summary` reports as p75 per route, so nothing is collected and
silently dropped — a URL that is set but unparseable stops the server from
booting instead.

## Images

Two problems travel under one name. **Bytes**: a 1920×1080 JPEG is 57 kB and the
same frame is 19 kB as WebP, and the phone downloading it can show 390 CSS
pixels of it anyway. **Layout**: an image with no declared size occupies nothing
until it arrives, so the page reflows around it — which making the image smaller
does not fix. `@nuxt/image` solves the first and merely permits the second to be
solved, so `<AppImage>` sits in front of it and refuses to render without an
intrinsic box.

[**docs/images.md**](./docs/images.md) is the guide; `/images` is the live demo.

```vue
<AppImage
  src="/images/hero-workspace.jpg"
  alt="A desk with a laptop and a mug"
  :width="1920"
  ratio="16/9"
  sizes="xs:100vw sm:100vw md:100vw lg:960px"
  priority
/>
```

Three things the guide is there to get right. **`sizes` is not the HTML
attribute** — the module wants `xs:100vw md:50vw` keyed on configured screens,
and the familiar `sizes="100vw"` is not rejected but filed under a screen named
`"1px"`, which renders a one-pixel-wide image with no warning anywhere; that is
what `utils/imageSizes.ts` throws on. **Source order is a decision, not a
measurement**: the browser takes the first `<source>` it can decode and never
compares sizes, and on the flat synthetic samples in `public/images/` WebP
actually beats AVIF (19.1 kB against 26.2 kB at 1920 wide) — AVIF leads because
it wins on photographs, which is a bet about your content. And **three things
have to agree to reserve the space** — the `width`/`height` attributes, the CSS
`aspect-ratio`, and the ratio IPX crops each `srcset` variant to — because a 3:4
source in a 1:1 box with correct attributes still delivers the wrong shape.

## Bundle budgets

`nuxt build` prints one size for the client bundle, and no visitor ever
downloads it. What a page load actually fetches is the entry chunk, the chunk
for that page, and the static imports of both — so that is what `pnpm
bundle:budget` measures, per route, gzipped, against a ceiling per route in
`bundle-budget.config.ts`. It runs in CI after every build.

[**docs/bundle-budget.md**](./docs/bundle-budget.md) is the guide.

```sh
pnpm build && pnpm bundle:budget
# /islands   144.5 kB  152.0 kB   6.58 kB  7.25 kB   400.7 kB
# Shared baseline: 137.9 kB gzipped across 21 files, budget 145.0 kB
```

Three things the guide is there to get right. **Two budgets per route, not
one** — a total and the route's own share — because a page importing a chart
library and a component added to `app.vue` are different failures, and the
second one otherwise shows up as every route breaking at once. **Dynamic
imports do not count**: Nuxt prefetches every other page's chunk at idle, and
counting those would give every route the same number, the whole application.
And **the model is checked against a real document** on every run: the computed
asset set for the one prerendered route is diffed against the `<link>` tags in
the HTML the build wrote, because a manifest walk that a Nuxt upgrade has made
obsolete would otherwise keep reporting confident numbers.

## Security headers and CSP nonces

Every response carries a policy, applied by the `request` hook in
`server/plugins/security-headers.ts` — before Nitro's static handler, so the
prerendered page and the `/_nuxt/` assets get it too. The `render:html` half
writes the same request's nonce onto the inline `<script>` tags Nuxt emits, so
the header and the document always agree.

[**docs/security-headers.md**](./docs/security-headers.md) is the guide.

```sh
curl -sI localhost:3000/ | grep -i content-security-policy
# content-security-policy: default-src 'self'; base-uri 'none'; object-src 'none';
#   script-src 'self' 'nonce-ICdt8qflyOyD5I29SbTWSQ=='; … frame-ancestors 'none'
```

Three things the guide is there to get right. **A nonce and `'unsafe-inline'`
are alternatives, never both** — a browser that understands the nonce ignores
`'unsafe-inline'` in the same directive, so writing both yields a policy that
reads strict and allows every inline script. **Prerendered and cached HTML
cannot have a nonce**, because the body outlives the request that made it; those
pages are served `'unsafe-inline'` instead, the set is derived from
`route-rules.config.ts` rather than maintained by hand, and the build fails if
`definePageMeta({ prerender: true })` freezes a page the header still thinks is
dynamic. And **`pnpm dev` runs a weaker policy** than a build — Vite needs
`'unsafe-eval'` and inline styles — so the policy gets signed off against
`node .output/server/index.mjs`, never against the dev server.

## Session security: httpOnly cookies, sealed sessions, rotation

The session is a sealed cookie: encrypted and signed with
`NUXT_SESSION_PASSWORD`, with nothing about the user kept server-side. There is
no token endpoint and nothing for the client to store — `useAuth()` returns the
user, never a credential.

[**docs/session-security.md**](./docs/session-security.md) is the guide.
`nuxt.config.ts` sets the cookie from `HARDENED_SESSION_TRANSPORT`, and
`server/plugins/session-hardening.ts` compares the **resolved** config against it
at boot and refuses to start if a `NUXT_SESSION_*` override has weakened
something:

```sh
NUXT_SESSION_COOKIE_HTTP_ONLY=false node .output/server/index.mjs
# Refusing to start: the session configuration is not safe (1 problem).
#   1. runtimeConfig.session.cookie.httpOnly is false, not true. …
```

Three things worth knowing. **The cookie is the only carrier**: h3 otherwise
accepts a sealed session in an `x-nuxt-session-session` request header, which a
script can set, so `sessionHeader` is `false` — and it has to be the _boolean_,
because h3 tests `!== false` and an environment variable that stayed a string
leaves the header path open while reading as though it were shut. **The session
id rotates** every 15 minutes, on an API request, with a 30-second grace window
for requests already in flight — and the id that rotates is one this app mints,
because h3's own is recovered by unsealing the cookie the request carries and no
API changes it, `replaceUserSession` included. And **a sign-in ends** after seven
days however much it rotated, so the bound on a session is this app's rather than
an h3 implementation detail.

## Spec Progress

See [SPEC.md](./SPEC.md).
