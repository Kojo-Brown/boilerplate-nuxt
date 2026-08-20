# Spec: boilerplate-nuxt

> Spec-driven. Mark `[x]` only after pushing.

## Phase 0 — Green Baseline (blocks all feature work)

- [x] Verify every dependency version actually exists on the registry and fix the ones that do not, then commit a lockfile
- [x] Get `install`, `typecheck`, `lint`, `test`, and `build` all passing locally from a clean clone
- [x] Promote `workflow-templates/ci.yml` to `.github/workflows/ci.yml` and confirm it runs green on a PR
- [x] Add a CI job matrix covering the supported Node version and fail the build on any warning — `engines.node` declared as `^22.19.0 || ^24.11.0`; every gate runs on both majors with `fail-fast: false` (PR #20)

Phase 0 items 1-3 complete as of PR #19 (2026-07-30): install
(`--frozen-lockfile`, no peer warnings), typecheck, lint (0 errors, 0 warnings),
format check, 153 unit tests, and build all green in CI on Node 22. Playwright
E2E is not wired into CI yet.

**Phase 0 complete as of PR #20 (2026-08-01).** All eight jobs — lint,
typecheck, unit tests, and build on Node 22 and Node 24 — green, with 153
tests per leg. Warnings are failures on four fronts: `--strict-peer-dependencies`,
`engine-strict=true` in `.npmrc`, `eslint --max-warnings=0`, and per-step
`NODE_OPTIONS=--throw-deprecation`. The three warnings CI was actually
emitting were fixed at the source, not muted: `pnpm.onlyBuiltDependencies`
approves esbuild/unrs-resolver, `if-no-files-found: ignore` covers the empty
coverage upload, and every action moved to a `using: node24` major
(checkout v7, setup-node v6, upload-artifact v6, pnpm/action-setup v6) to
clear the Node-20 deprecation annotation. Both legs were also run locally
against real Node 22.22.2 and 24.18.1 binaries before pushing.

Known gaps carried into Phase 6: Playwright E2E is still not wired into CI —
it needs a running app and a browser-caching decision across the matrix.
`@types/node` remains at `^22` (typechecks cleanly under the Node 24 leg).
The matrix covers Node majors only, on a single `ubuntu-latest` runner, and
actions are pinned by major tag rather than commit digest.

## Phase 1 — Foundation

- [x] Nuxt 4.4 + TypeScript 6 scaffold with strict mode
- [x] TailwindCSS 4 via `@tailwindcss/vite` with CSS variable tokens
- [x] ESLint 9 (Nuxt flat config) + Prettier
- [x] Path alias auto-import (Nuxt built-in)
- [x] Zod-validated runtime config (`runtimeConfig` + validation)

## Phase 2 — Auth & State

- [x] Nuxt Auth Utils (`nuxt-auth-utils`) with credentials + GitHub provider
- [x] Pinia store with `defineStore` + persist plugin
- [x] `useAuth()` composable wrapping session
- [x] Route middleware: `auth.ts` global middleware

## Phase 3 — Data Layer

- [x] `$fetch` typed API layer with request/response interceptors
- [x] `useAsyncData` patterns: polling, refresh, dedupe
- [x] Drizzle ORM + PostgreSQL via Nuxt server API routes
- [x] File upload via Nuxt server route + S3

## Phase 4 — UI System

- [x] UI primitives composing with `<slot>` pattern: Button, Modal, Toast
- [x] Dark mode via `@nuxtjs/color-mode`
- [x] i18n with `@nuxtjs/i18n` (en + fr example)
- [x] SSG vs SSR page-level config examples

## Phase 5 — Testing & DevOps

- [x] Vitest for unit/composable tests
- [x] Playwright E2E with `@nuxt/test-utils`
- [x] GitHub Actions: lint → typecheck → test → build
- [x] Dockerfile (Nuxt 4 output: node-server)

## Phase 6 — Vue 3 Advanced Reactivity

- [x] `shallowRef`, `triggerRef`, and `markRaw` for large-payload performance — `useLargeCollection` holds rows in a `shallowRef`, publishes in-place edits with one `triggerRef` per batch, and keeps its lookup index out of the reactivity system with `markRaw`; `pages/reactivity-performance.vue` measures the claims in-browser rather than asserting them (PR #21)
- [x] `effectScope` for grouped teardown in composables — `createSharedComposable` runs a factory in a detached scope and refcounts consumers, so shared state is built on the first subscribe and stopped on the last release rather than dying with whichever component mounted first; `useScopedEffects` covers the opposite lifetime, disposing the previous group on every `run()` so effects tied to a selection do not survive it; `pages/effect-scope.vue` drives both against real scopes (PR #22)
- [x] Custom `ref()` with debounce/throttle via `customRef` — `deferredRef` is the shared `customRef` shell (track/trigger, a `draft` of the uncommitted write, `pending` derived from the gap between draft and committed, `flush`/`cancel`, scope-bound teardown) and debounce and throttle differ only in a `CommitPlanner` deciding when a write reaches `commit`; `useDebouncedRef` publishes once the writes stop, `useThrottledRef` at most once per interval, and `pages/custom-ref.vue` counts keystrokes against searches and pointer events against publishes (PR #23)
- [x] Reactivity pitfalls guide: destructuring loss, `toRefs`, and deep-vs-shallow tradeoffs — `docs/reactivity-pitfalls.md` is the guide and `tests/unit/reactivity-pitfalls.test.ts` is its proof, one test per claim, so a Vue upgrade that changes a semantic fails CI on the line that documents it; `utils/reactivityInspect.ts` classifies any value without reading through it, and `pages/reactivity-pitfalls.vue` runs broken and fixed side by side against the same mutation (PR #24)
- [x] Composable design rules: no side effects on import, injectable deps, SSR-safe state — the convention was in `CLAUDE.md` and unenforced, and `useToast` had been breaking it since it was written; `eslint-rules/composable-design.mjs` turns two of the three rules into lint errors over `composables/`, `utils/`, and `stores/`, `tests/unit/composables/import-purity.test.ts` covers what a linter cannot see, and `useToast` moves to `useState` with injectable clock, randomness, and scheduler (PR #25)
- [x] `provide`/`inject` with typed `InjectionKey` and a dependency-inversion demo — `defineInjection` in `utils/injection.ts` mints the key and binds provide/inject to it, throwing a named error where Vue warns and returns `undefined` and telling a provided `undefined` apart from nothing at all; the demo is a real feature rather than a toy — `types/todos.ts` owns the `TodoGateway` port, `utils/todoGateway.ts` holds three peers (in-memory, HTTP, and a failure decorator), and `pages/dependency-inversion.vue` swaps between them under a subtree that never learns which it got (PR #26)
- [ ] Render functions + JSX for a dynamic table with slot forwarding

Item 5 complete as of PR #25 (2026-08-19). All gates green locally and in CI on
Node 22 and 24 — install, lint, format check, typecheck, test, build; 368 unit
tests, 46 of them new; coverage 88.99% statements / 96.00% branches / 94.68%
functions, thresholds unchanged. One devDependency added, `@typescript-eslint/types`
(types only, no runtime), so the rule file is checked against the real AST under
`// @ts-check` rather than annotated with `any`.

The item-2 gap named above turned out to be the smaller half of the problem.
`useToast` held `const toasts = ref<Toast[]>([])` at module scope, which on the
server is one array per _process_: one visitor's toast renders into the next
visitor's page, the list never shrinks, and the client's empty copy disagrees
with the markup it hydrates. `CLAUDE.md` had said "no module-scope mutable
state" since the repo was created. Nothing checked.

So the deliverable is the enforcement, not the fix. `no-module-state` reports
module-scope `let`/`var`, the Vue reactive factories, mutable containers, and
bare object/array literals, accepting `as const` and `Object.freeze`;
`no-import-side-effects` reports top-level expression statements and top-level
`await`, matched as an expression so an `await` in an initializer is caught too.
Both are scoped to `composables/`, `utils/`, and `stores/` — `plugins/` and
`server/` are excluded because import-time setup is what a plugin is for and
Nitro handlers already run per-request.

Neither gate was assumed to work. Reverting `useToast` to the module-scope ref
fails 23 of its 29 tests, including all three isolation cases; planting a
`setTimeout` inside a top-level initializer is invisible to the lint rule and
caught by the import-purity test, which is the division of labour the two halves
exist for. The lint tests drive the project's real `eslint.config.mjs` through
ESLint's Node API rather than `RuleTester`, so a rule wired to the wrong glob
fails them.

Known gaps carried into item 6: the two rules cannot see calls in a top-level
initializer (`z.object({…})` and `connect()` are the same syntax) or effects
reached through a variable, and `.vue` files are out of scope — all four stated
in `docs/composable-design-rules.md` rather than left implied. Nothing checks
that `useState` keys are unique. The `import.meta.server` guard in the default
toast scheduler is the one uncovered line in the file: it is false in the node
test environment by construction, which is why branch coverage is 0.39pt below
the previous run. `createSharedComposable` is still per-process — deliberately
now, and documented as the one exception to the SSR-safe-state rule. E2E remains
unwired from CI, so the Chromium run against the production build (login,
`/ui-primitives`, a toast appearing on click and gone 4.5s later, clean console)
was manual verification that will not re-run.

Item 6 complete as of PR #26 (2026-08-20). All gates green locally from a clean
`node_modules` and in CI on Node 22 and 24 — install, lint, format check,
typecheck, test, build; 425 unit tests, 54 of them new; coverage 91.61%
statements / 96.94% branches, up from 88.99% / 96.00%, with `utils/injection.ts`
and `utils/todoGateway.ts` at 100% on every metric and thresholds unchanged. No
dependencies added.

Two problems live in this one API and the item is only half done if they are
conflated. Prop drilling is plumbing. Dependency inversion is design: a
component that calls `$fetch('/api/todos')` depends on the network, so it only
runs where the network, a database and a session all exist. `InjectionKey<T>`
solves the first and half of the second — it types the value but not its
absence, so `inject(key)` is `T | undefined` for something mandatory in every
real render, which is how the pattern degenerates into `inject(key)!`.
`defineInjection` closes that: `inject()` throws at the injection site naming
the key, "not provided" is a private symbol rather than `undefined` (so
`isProvided`/`injectOr` stay correct for a nullable `T`), and being called
outside a setup context is a different message from nobody having provided it.

The port is the deliverable, not the components. `createInMemoryTodoGateway` is
not a mock — it trims titles, rejects blanks and rejects unknown ids exactly as
the Nitro routes do — which is what lets it back the demo page and the tests
alike, and `createFaultyTodoGateway` decorates any gateway so the error path is
something you can look at on purpose. The HTTP adapter is where the wire format
stops: `updatedAt` is dropped because nothing renders it. What that buys is
visible in the suite — `useTodoList` is covered through loading, adding,
toggling, deleting, four failure paths and an out-of-order refresh with no
`$fetch` stub, no database and mostly no component.

Neither of the two subtle claims was assumed. Removing the refresh generation
guard, and swapping the missing-value sentinel for `?? undefined`, each fail
exactly the one test that documents them. Provide/inject itself is tested by
rendering real trees with `renderToString`, which also pins the SSR claim: a
provided value lives on the app, and Nuxt builds one app per request.

Known gaps carried into item 7: E2E is still unwired from CI, so the Chromium
run against the production build (in-memory board seeded, add/toggle/delete
tracked in `TodoStats` three levels below the provider, the flaky adapter's
second Add rejecting with the typed text kept, the HTTP adapter surfacing a 500
from a database that is not running) was manual verification that will not
re-run. `/dependency-inversion` sits behind the global auth middleware and is
unlinked from `pages/index.vue`, like every demo page here. No plugin ships an
app-wide default gateway — the page provides at the subtree instead, and
`TodoGatewayProvider` reads its prop once on purpose, so switching adapters
costs a remount. `createSharedComposable` is still per-process.

## Phase 7 — Nitro & Server Engine

- [ ] Nitro route rules: per-route ISR, SWR, prerender, and CORS config
- [ ] Server middleware with typed `H3Event` context and request-scoped auth
- [ ] Nitro storage layer (`useStorage`) with a Redis driver for cache and sessions
- [ ] Cached server functions with `defineCachedEventHandler` + tag invalidation
- [ ] Streaming SSR responses with `sendStream` and progressive rendering
- [ ] Server-Sent Events endpoint with heartbeat and disconnect cleanup
- [ ] WebSocket handler via Nitro with JWT handshake auth
- [ ] Idempotency keys on mutating server routes with a dedupe store

## Phase 8 — Data & Performance

- [ ] Drizzle transactions with an outbox row + a relay worker
- [ ] Optimistic concurrency with a `version` column and conflict UI
- [ ] `useAsyncData` cache keys, `getCachedData`, and payload-size discipline
- [ ] Islands / server components for zero-JS content sections
- [ ] Core Web Vitals instrumentation reported to an analytics sink
- [ ] Bundle budget gate in CI + per-route payload report
- [ ] Image optimisation with `@nuxt/image`, AVIF/WebP, and CLS-safe ratios

## Phase 9 — Security & Accessibility

- [ ] CSP with nonces via Nitro middleware, plus HSTS and security headers
- [ ] Token storage hardening: httpOnly cookies only, sealed sessions, rotation
- [ ] CSRF protection on all state-changing server routes
- [ ] Rate limiting in Nitro middleware backed by storage
- [ ] OWASP Top 10 checklist with a test per mitigation
- [ ] WCAG 2.2 AA audit with axe in CI, zero-violation gate
- [ ] Focus management and route-change announcements for SPA navigation

## Phase 10 — TDD & Advanced Testing

- [ ] TDD kata: one composable built red→green→refactor, one commit per step
- [ ] Component testing with `@nuxt/test-utils` mount helpers and SSR assertions
- [ ] Mutation testing with Stryker + a CI threshold
- [ ] Testcontainers-backed integration tests against real Postgres
