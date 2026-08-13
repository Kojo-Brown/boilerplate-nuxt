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

## Spec Progress

See [SPEC.md](./SPEC.md).
