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

## Spec Progress

See [SPEC.md](./SPEC.md).
