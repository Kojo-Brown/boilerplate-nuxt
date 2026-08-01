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

## Spec Progress

See [SPEC.md](./SPEC.md).
