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
- [x] Render functions + JSX for a dynamic table with slot forwarding — the loop was never the hard part; the slot names are, since each cell resolves `cell:<column id>`, a name derived from data that a template can only reach through `<template v-slot:[expr]>`, whose argument is not type-checked at all. `components/DataTable.tsx` renders the column list it is handed and holds no state, `utils/dataTable.ts` owns everything that can be wrong about it (the value type is erased at `defineColumn`, so a heterogeneous column list is one array; the sort is stable in _both_ directions, since negating a comparator also negates its tiebreak and would swap equal rows on every flip), and `components/DataTableSection.tsx` forwards every slot but its own to the table without naming any — it cannot, the set is open. `forwardSlots` returns a proxy rather than a spread because `ctx.slots` is not a snapshot: a slot behind a `v-if` appears after the first render, which a copy taken in `setup()` never sees. Three separate things erase the row type on the way to a slot scope, each answered in `docs/render-functions.md`: `defineComponent`'s setup-function overloads return a non-generic component (so these are plain functional components), an object prop declaration pins `P` ahead of the call signature (so the runtime lists are names), and inference does not pass through a generic function argument or a template (so each consumer binds it once with `DataTableSection<Invoice>`). No new dependency: `@vitejs/plugin-vue-jsx` was tried and rejected because its `vite` peer must bind to one of the two Vites here — Nuxt builds on 8, Vitest runs on 7 — and either choice broke `nuxt.config.ts`; Vitest gets the transform from `vue/jsx-runtime` via esbuild instead. `pnpm build` was the only gate that caught the missing default export Nuxt's auto-import resolves to, and the page was checked in the built server, not just compiled: five headers, 25 cells, `aria-sort` descending on one sortable column and `none` on three, absent on the unsortable one, and all four slots arriving through the wrapper (PR #27)

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

- [x] Nitro route rules: per-route ISR, SWR, prerender, and CORS config (PR #28)
- [x] Server middleware with typed `H3Event` context and request-scoped auth — `middleware/auth.global.ts` is a router guard that ships in the client bundle and `curl` never runs, so until this item every route under `server/api/` answered anyone who asked (PR #29)
- [x] Nitro storage layer (`useStorage`) with a Redis driver for cache and sessions — mounted at runtime from `runtimeConfig`, because Nitro's `storage` config is serialised into the build and would bake a Redis URL into `.output/` (PR #30)
- [ ] Cached server functions with `defineCachedEventHandler` + tag invalidation
- [ ] Streaming SSR responses with `sendStream` and progressive rendering
- [ ] Server-Sent Events endpoint with heartbeat and disconnect cleanup
- [ ] WebSocket handler via Nitro with JWT handshake auth
- [ ] Idempotency keys on mutating server routes with a dedupe store

Item 2 complete as of PR #29 (2026-08-26). All gates green locally from a clean
`node_modules` and in CI on Node 22 and 24 — install, lint, format check,
typecheck, test, build; 552 unit tests, 43 of them new; coverage 93.09%
statements / 96.94% branches, up from 91.61% / 96.94%, thresholds unchanged. No
dependencies added.

The gap this closed was not a missing feature, it was a category error.
`middleware/auth.global.ts` decides which _pages_ a browser may navigate to; it
is a Vue Router guard, it lives in the client bundle, and the note in
`route-rules.config.ts` has said since PR #28 that it never applied to `server/`.
It was UX that read like a gate. `server/api/todos`, `/uploads`, `/posts` and
`/metrics` were all open to an unauthenticated `curl`.

`server/utils/access-policy.ts` is now a default-deny table — `/api/**` requires
a session, every public route is an explicit carve-out with its reason attached —
and `server/middleware/10.auth.ts` enforces it while resolving the session once
onto `event.context.auth`. That single resolution is deliberately _not_ sold as a
performance win: h3 already caches the unsealed session on
`event.context.sessions`, so five `getUserSession()` calls were one decrypt
already. What it buys is a check in one place that cannot be forgotten, and a
`RequestAuth` discriminated union whose authenticated case has a non-nullable
`user`. `requireAuth(event)` narrows by throwing, and throws two different errors
on purpose — 401 with no session, 500 naming the policy file when no middleware
resolved one at all, since a caller cannot fix the latter by logging in.

Two of the public carve-outs are consequences of caching rather than
conveniences, and they generalise the constraint PR #28 recorded for prerender:
**a response that is cached or prerendered cannot be per-user**.
`/api/route-rules/**` is `swr`/`isr`/`cors`, `/api/rendering/**` backs the SSR of
a page cached for 60s. Neither has a user to forward.

Nothing was assumed. The policy matches `normalisePathname(event.path)` because
`/api/route-rules/%2e%2e/todos` otherwise reads as public and resolves as
protected; the built server returns 401 for that spelling and for the double- and
triple-encoded forms, the trailing slash, the doubled slash and the query-string
variant. The three new gates were each mutation-checked (flipping the policy
default to public fails 10 tests, dropping the decode pass fails 6, removing the
request-id whitelist fails 3), and the `H3EventContext` augmentation was probed
rather than presumed — `event.context.requestId` reports as `string`, not `any`.

Known gaps carried into item 3. **Authentication, not authorisation**: neither
`todos` nor `uploads` has a user column, so nothing enforces ownership — row-level
scoping belongs with the Drizzle work in Phase 8, and `/api/posts` still returns
generated demo data (its `authorId` is now the session user's id rather than a
hardcoded `'1'`, which is the one real use of the request-scoped user). There are
no roles: `RouteAccess` has `public` and `authenticated` and nothing else. Rate
limiting and CSRF are Phase 9 items and will hang off this middleware. E2E is
still unwired from CI, so the runtime behaviour was verified by curl against
`node .output/server/index.mjs` rather than by a test that re-runs — including the
measurement that makes the `useRequestFetch()` change load-bearing: logged in,
`/data-patterns` renders 13,096 bytes with its data and 10,597 bytes of errors
with a plain `$fetch`, both 200, because `useAsyncData` files a 401 under `error`
instead of throwing. `vitest.config.ts` gained the four project-root aliases Nuxt
defines so a test can import `~/server/…` the way production does.

One environment note that is not a defect in this change: an incremental
`pnpm install` over a warm `node_modules` produced a `.nuxt/tsconfig.json`
mapping `vite/client` to vitest's Vite 7 rather than Nuxt's Vite 8, failing
`pnpm typecheck` at `nuxt.config.ts:29` on a rollup-vs-rolldown `PluginOption`
mismatch. It reproduces on unmodified `main`, clears on a fresh install, and CI
installs fresh — but it is real fragility in `nuxt prepare`'s resolution.

Item 3 complete as of PR #30 (2026-08-28). All gates green from a deleted
`node_modules` and in CI on Node 22 and 24 — install (`--frozen-lockfile
--strict-peer-dependencies`), lint, format check, typecheck, test, build; 630
unit tests, 78 of them new; coverage 93.96% statements / 97.35% branches, up from
93.09% / 96.94%, thresholds unchanged. Two runtime dependencies added:
`unstorage` and `ioredis`, the latter pinned to `^5.11.1` rather than the current
6.0.0 because `unstorage`'s peer range is `^5.4.2` and CI installs strictly.

The mount happens in a Nitro plugin at startup, not in `nuxt.config.ts`, and that
is the whole design. Nitro's `storage` config is serialised into the build, so a
Redis URL written there — or read there from `process.env`, the same mistake with
an extra step — ships inside `.output/` and pins one image to one Redis. The URL
is `runtimeConfig.redis.url`; `server/utils/storage.ts` turns config into a mount
plan and is where every decision lives, and `server/plugins/storage.ts` is the
thin part that applies it.

`cache` is not this app's base. Nitro writes to it, which means the `swr`/`isr`
rules from PR #28 were caching **per process**: two instances had two independent
caches, so a client saw a stale response and a fresh one alternately, and a
rolling restart discarded both. That is fixed by mounting it, and nothing here
writes to it — `defineCachedEventHandler` is item 4.

`sessions` is new, and closes the gap PR #29 left open in the other direction.
That item made the 401 true; it could not make a session _end_. Sealed cookies
live in the browser, so `clear()` is a request, not a revocation — a copy taken
beforehand kept working until `maxAge` elapsed. The registry stores one record
per session keyed `<userId>:<sessionId>`, sign-in writes it,
`/api/auth/logout` sets `revokedAt`, and `10.auth.ts` rejects a revoked session.
The key leads with the user id so "sign out everywhere" is a prefix scan of one
user rather than of the store.

Two trades, both stated in `docs/nitro-storage.md` rather than left to be found.
**Unconfigured is supported; misconfigured is fatal** — no URL keeps Nitro's
per-process driver, which is right for dev and one instance, but a URL that is
set and unusable throws at boot, because a server that starts, passes staging and
then silently splits its cache and registry per instance is the worse failure.
**A missing record is `unknown` and passes** — fail-closed would make Redis a
hard dependency of authentication, signing out every user at once during an
outage, operator included, and would invalidate every session issued before this
existed. The costs of that choice are named too: one storage read per
authenticated request, and revocation only as durable as the base.

Verified against a real `redis-server` on the built output, since the memory
driver the unit tests use exercises neither expiry nor the driver: login wrote
`…:sessions:1:<uuid>` and an `swr` request wrote `…:cache:nitro:routes:…`, so both
bases land in Redis; a cookie captured before logout returned 200 and then 401
`Session revoked`, with the tombstone's TTL re-derived to the cookie's remaining
lifetime rather than inheriting the longer mount default;
`NUXT_REDIS_URL=postgresql://user:hunter2@…` exited 1 without listening and
without the password appearing in the output; and with no URL the server logged
the per-process warning once, then served.

Gaps carried into item 4. There is **no UI** for listing or revoking sessions —
`useAuth().logout('all')` is the only entry point, and a device list wants the
`provider` and `createdAt` the record already carries. The revocation flow has
**no Playwright coverage**: CI runs no Redis service, so the end-to-end proof
above is manual and does not re-run. `revokeAllSessionsForUser` is a `SCAN` and
is deliberately off the request path. Nothing yet uses the `cache` base directly;
that starts with `defineCachedEventHandler`.

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
