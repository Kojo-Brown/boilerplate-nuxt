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
- [ ] Custom `ref()` with debounce/throttle via `customRef`
- [ ] Reactivity pitfalls guide: destructuring loss, `toRefs`, and deep-vs-shallow tradeoffs
- [ ] Composable design rules: no side effects on import, injectable deps, SSR-safe state
- [ ] `provide`/`inject` with typed `InjectionKey` and a dependency-inversion demo
- [ ] Render functions + JSX for a dynamic table with slot forwarding

Item 2 complete as of PR #22 (2026-08-13). All gates green locally and in CI on
Node 22 and 24; 212 unit tests, 25 of them new; coverage 84.4% statements /
93.9% branches, unchanged thresholds.

Two decisions worth keeping. Both primitives create their inner scopes
_detached_ and bind teardown explicitly, because `run()` is normally called
from an event handler or a watcher callback where the ambient scope is either
absent or the wrong owner — adopting it is the bug the primitives exist to
prevent. And `createSharedComposable` checks instance identity before stopping:
a consumer that outlives an explicit `dispose()` still fires its release
callback, and without the guard it would tear down the instance that had
replaced it. There is a test for that race specifically.

Known gaps carried into item 3: `createSharedComposable` is per-process, not
per-request, so subscribing during SSR would share state across requests —
documented in its docblock, with `useState` named as the tool for per-request
state, but not enforced by anything. The demo page uses stand-in `effectScope`s
rather than real child components, which makes the refcount visible but leaves
the mount/unmount path covered only by unit tests. It has no Playwright spec —
E2E is still unwired from CI, so one would add an unrun test rather than a gate
— and, like every other demo page here, it sits behind the global auth
middleware and is unlinked from `pages/index.vue`. `useLargeCollection` from
item 1 is still not virtualised.

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
