import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vitest/config'

// Same prefix-substitution caveat as `vitest.config.ts`: `new URL('.', …)` keeps
// a trailing separator and the alias replacement would produce `<root>//server/…`.
const root = fileURLToPath(new URL('.', import.meta.url)).replace(/[\\/]+$/, '')

/**
 * The integration suites: real Postgres, started by Testcontainers.
 *
 * A third config rather than another project inside `vitest.config.ts`, because
 * these suites need a Docker socket and the unit suite must stay runnable
 * without one. Keeping them apart is also what lets CI report "the integration
 * gate is red" instead of "some test somewhere failed" — see
 * `docs/integration-testing.md`.
 */
export default defineConfig({
  resolve: {
    alias: {
      '~~': root,
      '@@': root,
      '~': root,
      '@': root,
    },
  },

  test: {
    globals: true,
    environment: 'node',
    include: ['tests/integration/**/*.test.ts'],

    // Starts one container for the whole run and migrates it from empty.
    globalSetup: ['tests/integration/setup/global.ts'],

    // No `tests/setup.ts`. That file stubs Nuxt's auto-imports for code that
    // calls `useState` and friends; nothing under test here does — the stores
    // take their database as an argument, which is the reason they can be
    // tested at all.

    // One fork, one suite at a time, against one database. The suites share a
    // server and each truncates what it touches, so running two at once would
    // make every `beforeEach` a race against another suite's fixtures. The
    // concurrency these tests are about is between *connections*, which they
    // open themselves and control exactly.
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    fileParallelism: false,

    // A test here can wait on a lock on a cold CI runner, which the 5s default
    // is not generous enough for; the hook allowance covers the first
    // connection against a container that has only just reported ready.
    testTimeout: 30_000,
    hookTimeout: 60_000,

    // No coverage block. Coverage of `server/utils/**` is the unit suite's
    // number and has a threshold there; measuring the same files again from a
    // suite that exists to cover a handful of SQL-shaped properties would
    // report a figure that means nothing on its own.
    reporters: ['verbose'],
    typecheck: {
      enabled: false,
    },
  },
})
