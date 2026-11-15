# boilerplate-nuxt — Agent Instructions

## What this repo is

Production-grade Nuxt 4 full-stack boilerplate. Spec-driven and PR-driven: one `SPEC.md` item per run.

## Your job (scheduled agent, every 4h)

1. `git checkout main && git pull --ff-only origin main`
2. Read `SPEC.md`, take the **first** `- [ ]` item. Phase 0 items always win.
3. `git checkout -b <type>/<kebab-slug>` (`feat`/`fix`/`chore`/`ci`/`docs`)
4. Implement it completely — source, types, tests, docs.
5. Run every gate locally; **all must pass** before pushing:
   ```
   pnpm install
   pnpm typecheck
   pnpm lint
   pnpm test
   pnpm test:integration
   pnpm build
   ```
   `pnpm test:integration` is the `integration` CI job and blocks a merge like
   the rest, so it belongs in this list. It is seconds of work: `globalSetup`
   starts one `postgres:17-alpine` through Testcontainers, applies
   `server/db/migrations/*.sql` to an empty database, and the suites run
   serially against it. All it needs is a Docker socket — no service to start,
   no `DATABASE_URL` to set. See `docs/integration-testing.md` before adding a
   suite; the three rules that bite are that a held transaction occupies its
   own connection (every client is `max: 1`, so observe it from a third one),
   that a blocked session cannot be asked whether it is blocked, and that a
   Drizzle builder does not reach the wire until something subscribes to it.
6. Commit, `git push -u origin <branch>`, then `gh pr create`.
7. `gh pr checks --watch` → **merge only if every check is green**:
   `gh pr merge --squash --delete-branch`
8. Pull main, mark the item `- [x]` in `SPEC.md`, update
   `../PROGRESS.md`, push as a `chore:` commit.

If a check fails, fix forward on the same branch. Never merge red. Never
weaken a test or lower a threshold to force green — if a gate is genuinely
wrong, change it deliberately and say why in the PR.

## Secrets

Never commit real credentials, tokens, keys, or `.env` files. Placeholders in
`.env.example` only; CI reads from the GitHub secret store. Test fixtures must
look obviously fake. Scan `git diff --cached` before every push.

## Conventions

- Server routes in `server/api/`, typed via `H3Event`
- Drizzle for all DB access; no raw SQL in route handlers
- Composables are SSR-safe: no module-scope mutable state
- Secrets only via `runtimeConfig`, never `NUXT_PUBLIC_*`
- Pinia for client state, `useAsyncData` for server state

See `../ROUTINE.md` for the full workflow.
