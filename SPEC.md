# Spec: boilerplate-nuxt

> Spec-driven. Mark `[x]` only after pushing.

## Phase 1 — Foundation
- [x] Nuxt 4.4 + TypeScript 6 scaffold with strict mode
- [x] TailwindCSS 4 via `@nuxtjs/tailwindcss` with CSS variable tokens
- [x] ESLint 9 (Nuxt flat config) + Prettier
- [x] Path alias auto-import (Nuxt built-in)
- [x] Zod-validated runtime config (`runtimeConfig` + validation)

## Phase 2 — Auth & State
- [x] Nuxt Auth Utils (`nuxt-auth-utils`) with credentials + GitHub provider
- [x] Pinia store with `defineStore` + persist plugin
- [x] `useAuth()` composable wrapping session
- [x] Route middleware: `auth.ts` global middleware

## Phase 3 — Data Layer
- [ ] `$fetch` typed API layer with request/response interceptors
- [ ] `useAsyncData` patterns: polling, refresh, dedupe
- [ ] Drizzle ORM + PostgreSQL via Nuxt server API routes
- [ ] File upload via Nuxt server route + S3

## Phase 4 — UI System
- [ ] UI primitives composing with `<slot>` pattern: Button, Modal, Toast
- [ ] Dark mode via `@nuxtjs/color-mode`
- [ ] i18n with `@nuxtjs/i18n` (en + fr example)
- [ ] SSG vs SSR page-level config examples

## Phase 5 — Testing & DevOps
- [ ] Vitest for unit/composable tests
- [ ] Playwright E2E with `@nuxt/test-utils`
- [ ] GitHub Actions: lint → typecheck → test → build
- [ ] Dockerfile (Nuxt 4 output: node-server)
