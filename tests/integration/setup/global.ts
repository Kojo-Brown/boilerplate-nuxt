import { PostgreSqlContainer } from '@testcontainers/postgresql'
import postgres from 'postgres'
import type { TestProject } from 'vitest/node'

import { applyMigrations } from './migrate'

declare module 'vitest' {
  interface ProvidedContext {
    /** Connection string for the throwaway Postgres this run started. */
    databaseUrl: string
  }
}

/**
 * The Postgres image the suites run against.
 *
 * Pinned to the major this project targets rather than to `latest`, because the
 * behaviour under test is Postgres' own — row locks, `SKIP LOCKED`, the
 * re-evaluation a blocked `UPDATE` does when the transaction ahead of it commits
 * — and a suite that silently moved to the next major would be measuring a
 * different database than the one the deployment notes name. `-alpine` for the
 * pull time; nothing here needs a locale or an extension the slim image drops.
 */
export const POSTGRES_IMAGE = 'postgres:17-alpine'

/**
 * Starts one Postgres for the whole run and migrates it from nothing.
 *
 * One container, not one per suite: starting it is the expensive part (a second
 * or two), the suites run serially by configuration, and each one truncates what
 * it touches, so a shared server is both faster and no less isolated. See
 * `docs/integration-testing.md`.
 *
 * Migrating from empty is deliberate and is itself a gate. The alternative —
 * `drizzle-kit push`, which diffs `schema.ts` straight onto the database — would
 * build the schema the TypeScript declares rather than the schema this
 * repository's migrations produce, and those are exactly the two things that can
 * drift. They had: `uploads` was in `schema.ts` and in three route handlers with
 * no migration creating it, and `push` would have hidden that for as long as it
 * was wired up.
 *
 * The credentials below are the container's, invented here and thrown away with
 * it. They are not a secret and are not read from the environment on purpose: a
 * value pulled from `DATABASE_URL` would let a developer's own database be the
 * thing these suites truncate.
 */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const container = await new PostgreSqlContainer(POSTGRES_IMAGE)
    .withDatabase('nuxt_integration_test')
    .withUsername('integration_test_user')
    .withPassword('integration-test-password-not-a-secret')
    .start()

  const databaseUrl = container.getConnectionUri()
  const sql = postgres(databaseUrl, { max: 1, onnotice: () => {} })

  try {
    await applyMigrations(sql)
  } finally {
    await sql.end()
  }

  project.provide('databaseUrl', databaseUrl)

  return async () => {
    await container.stop()
  }
}
