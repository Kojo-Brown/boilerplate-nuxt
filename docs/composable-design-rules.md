# Composable Design Rules

A composable is a module, and on the server a module is evaluated **once per
process** — not once per request. Nuxt then auto-imports it into every render
that mentions it. So anything a composable holds at module scope is shared by
every visitor that process serves, and anything it runs at module scope runs
before any request exists.

That is the whole basis for the three rules below. Client-side they cost
nothing to follow; server-side, breaking them is how one user's data ends up in
another user's HTML.

Two of these rules are enforced. `composables/`, `utils/`, and `stores/` are
linted by [`eslint-rules/composable-design.mjs`](../eslint-rules/composable-design.mjs)
(wired in `eslint.config.mjs`, so `pnpm lint` fails on a violation), and every
module in those directories is imported with side effects instrumented by
[`tests/unit/composables/import-purity.test.ts`](../tests/unit/composables/import-purity.test.ts).
The third — SSR-safe state — is only partly mechanical; what a linter can see of
it is covered by the same rule, and the rest is the reasoning below.

---

## Rule 1 — No side effects on import

**Importing a composable must do nothing but define things.** No timers, no
listeners, no requests, no writes to anything shared.

```ts
// ✗ runs when the module is imported: once per process, before any request
const socket = new WebSocket(url)
setInterval(refresh, 30_000)
const config = await loadConfig()

// ✓ runs when the composable is called: once per caller, inside a request
export function useLiveFeed() {
  const socket = new WebSocket(url)
  onScopeDispose(() => socket.close())
  return { socket }
}
```

Three things go wrong when work happens at import time:

- **It runs before there is a Nuxt app.** `useRuntimeConfig()`, `useState()`,
  and `useNuxtApp()` all resolve against the app instance being rendered. At
  module-evaluation time there is none, so they throw — or worse, bind to
  whichever app happened to be current.
- **It runs once, not once per request.** A `WebSocket` opened at import is a
  single connection for the whole process, opened before the first visitor
  arrives and never closed.
- **It runs whether or not anyone calls the composable.** Nuxt auto-imports the
  directory; a module imported for one exported type still evaluates its whole
  top level.

Top-level `await` is the same problem with an extra edge: it makes every
importer an async module, so an unrelated page pays for the wait.

**Enforced by** `composable-design/no-import-side-effects` (bare expression
statements and top-level `await`) and by the import-purity test, which imports
each module with `setTimeout`, `setInterval`, `setImmediate`, `queueMicrotask`,
`fetch`, `process.on`, and `console` instrumented, and fails if any of them is
touched or if a new global appears. The two halves cover different ground: the
linter cannot see through a function call, and the test cannot see state that is
declared but not yet written to.

**The escape hatch is `plugins/`.** A Nuxt plugin exists to do setup at load
time, receives the `nuxtApp` it belongs to, and runs once per app — which is
once per request on the server. `server/` is likewise exempt: Nitro handlers are
already written against a per-request `H3Event`.

---

## Rule 2 — Injectable dependencies

**A composable takes its ambient dependencies as an optional argument, with the
real ones as defaults.** Clocks, randomness, timers, transports.

```ts
export interface ToastDeps {
  now: () => number
  random: () => number
  schedule: ToastScheduler
}

export function useToast(deps: Partial<ToastDeps> = {}) {
  const { now = Date.now, random = Math.random, schedule = scheduleOnClient } = deps
  // …
}
```

Call sites are unchanged — `useToast()` still means "the real thing". A test
passes what it needs and defaults the rest:

```ts
const { schedule, advance } = createFakeScheduler()
const { addToast, toasts } = useToast({ schedule })

addToast({ message: 'saved', duration: 1000 })
advance(1000)
expect(toasts.value).toHaveLength(0)
```

`Partial<Deps>` rather than a fully-specified options object is the part that
makes this cheap to adopt: a test names one dependency instead of restating
four, and adding a new dependency later does not break existing callers.

Why not just patch the global? `vi.useFakeTimers()` and `vi.stubGlobal` do work,
and this repo still uses them where the seam genuinely is the global — but they
test that a global can be replaced, not that the composable has a seam. A
composable with injectable dependencies can also be reused with a different
transport in production, which a patched global cannot.

The reach-for-it-anyway list is short and worth being deliberate about: `Date`,
`Math.random`, `setTimeout`/`setInterval`, `fetch`, `crypto`, `localStorage`,
and anything that talks to the network. Vue's own APIs (`ref`, `watch`,
`computed`) are not dependencies in this sense — injecting them buys nothing.

This rule covers dependencies of a single call. For a dependency a whole
component subtree shares, the parameter has to be threaded through every layer
between, and `provide`/`inject` with a typed `InjectionKey` is the better tool —
not yet used here.

---

## Rule 3 — SSR-safe state

**State that must survive a render goes in `useState`, never in a module-scope
`ref`.**

```ts
// ✗ one array for the entire server process
const toasts = ref<Toast[]>([])
export function useToast() {
  return { toasts: readonly(toasts) }
}

// ✓ one array per Nuxt app: per request on the server, per tab on the client
export function useToast() {
  const toasts = useState<Toast[]>('app:toasts', () => [])
  return { toasts: readonly(toasts) }
}
```

The module-scope version is the bug this repo actually shipped, and it fails in
three ways at once:

1. **Cross-request leakage.** Request A pushes `"Payment failed"`; request B
   renders it. On a busy process this is not a race that occasionally fires — it
   is the normal case.
2. **Unbounded growth.** Nothing in a request's lifecycle clears it, so it holds
   every toast the process has ever created.
3. **A hydration mismatch.** The client's copy starts empty while the server
   rendered a full list, so Vue patches the difference away on hydration and the
   UI flickers.

`useState` fixes all three because the ref lives on the Nuxt app rather than in
the module: the server creates one app per request and serializes its state into
the payload, and the client picks up exactly what was rendered.

The regression is guarded directly — `tests/unit/composables/useToast.test.ts`
renders two apps and asserts neither sees the other's toasts. Against the
module-scope version those assertions fail.

### Which tool for which state

| State                                          | Use                                     |
| ---------------------------------------------- | --------------------------------------- |
| Per-request, must survive hydration            | `useState(key, init)`                   |
| Server data keyed by a request                 | `useAsyncData` / `useFetch`             |
| Domain state with actions and getters          | a Pinia store (per-app, same guarantee) |
| A client-only resource outliving one component | `createSharedComposable` from `utils/`  |
| Scratch state inside one call                  | a plain `ref` **inside** the composable |

`createSharedComposable` is the one entry that is deliberately _not_
per-request: it refcounts a detached `effectScope` per process, which is right
for a socket or a polling loop and wrong for anything user-specific. Subscribe
to it from the client only.

**Enforced by** `composable-design/no-module-state`, which reports module-scope
`let`/`var`, calls to the Vue reactive factories, `new Map`/`Set`/`WeakMap`/
`WeakSet`/`Array`/`Date`, and bare object or array literals. A literal made
readonly by `as const` or `Object.freeze()` is accepted — `as const` is a
compile-time guarantee and `Object.freeze` a runtime one, and either is enough
to make sharing it safe.

```ts
const LEVELS = ['info', 'error'] as const // fine
const LIMITS = Object.freeze({ retries: 3 }) // fine
const MAX_RETRIES = 3 // fine — primitives are immutable
const defaults = { retries: 3 } // reported: shared and writable
```

---

## What is not enforced

Worth stating plainly, because a gate that is trusted beyond its reach is worse
than no gate:

- **Calls in a top-level initializer are not linted.** `const schema =
z.object({…})` is fine and `const client = connect()` is not, and no rule can
  tell them apart from the syntax. The import-purity test catches the second one
  if it does anything observable.
- **Effects reached through a variable are invisible to both.** `const timer =
globalThis.setTimeout` then calling `timer(…)` defeats the spies.
- **`.vue` files are not covered.** The rules are scoped to the auto-imported
  `.ts` layers; state in a component's `<script setup>` is already per-instance.
- **Nothing checks that `useState` keys are unique.** Two composables choosing
  `'user'` silently share one ref. Namespace them (`'app:toasts'`).

If a rule is genuinely wrong for a file, disable it on the line with a comment
saying why — a silent `eslint-disable` for a whole file is how these stop
meaning anything.
