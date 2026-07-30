# Spec: boilerplate-nuxt

> Spec-driven. Mark `[x]` only after pushing.

## Phase 0 — Green Baseline (blocks all feature work)

- [x] Verify every dependency version actually exists on the registry and fix the ones that do not, then commit a lockfile
- [x] Get `install`, `typecheck`, `lint`, `test`, and `build` all passing locally from a clean clone
- [x] Promote `workflow-templates/ci.yml` to `.github/workflows/ci.yml` and confirm it runs green on a PR
- [ ] Add a CI job matrix covering the supported Node version and fail the build on any warning

Phase 0 items 1-3 complete as of PR #19 (2026-07-30): install
(`--frozen-lockfile`, no peer warnings), typecheck, lint (0 errors, 0 warnings),
format check, 153 unit tests, and build all green in CI on Node 22. Playwright
E2E is not wired into CI yet.

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

- [ ] `shallowRef`, `triggerRef`, and `markRaw` for large-payload performance
- [ ] `effectScope` for grouped teardown in composables
- [ ] Custom `ref()` with debounce/throttle via `customRef`
- [ ] Reactivity pitfalls guide: destructuring loss, `toRefs`, and deep-vs-shallow tradeoffs
- [ ] Composable design rules: no side effects on import, injectable deps, SSR-safe state
- [ ] `provide`/`inject` with typed `InjectionKey` and a dependency-inversion demo
- [ ] Render functions + JSX for a dynamic table with slot forwarding

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
