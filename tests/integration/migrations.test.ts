import { getTableConfig } from 'drizzle-orm/pg-core'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { outbox, todos, uploads } from '~/server/db/schema'

import { ALL_TABLES, connect, sqlState, truncateAll, type TestConnection } from './setup/database'
import { applyMigrations, migrationFiles } from './setup/migrate'

/**
 * Holds `server/db/migrations/` against `server/db/schema.ts`, on a database
 * built from the migrations and nothing else.
 *
 * This is the suite that cannot be faked. Every other test of this project's
 * data access drives Drizzle through the `pg-proxy` driver, which hands the
 * query builder a callback in place of a connection: it proves the *statement*
 * is the one intended, and it would prove that just as happily for a table no
 * migration has ever created. `uploads` was exactly that for two releases —
 * declared in `schema.ts`, inserted into by `POST /api/uploads`, read by
 * `GET /api/uploads`, and absent from every migration, so each of those routes
 * answered 500 against a real database while the suite stayed green.
 * `0003_uploads.sql` is the fix and this file is what makes the next one
 * impossible to miss.
 */
let connection: TestConnection

beforeAll(async () => {
  connection = await connect()
})

beforeEach(async () => {
  await truncateAll(connection.sql)
})

afterAll(async () => {
  await connection.close()
})

interface CatalogColumn {
  column_name: string
  data_type: string
  is_nullable: 'YES' | 'NO'
}

function columnsOf(table: string): Promise<CatalogColumn[]> {
  return connection.sql<CatalogColumn[]>`
    select column_name, data_type, is_nullable
      from information_schema.columns
     where table_schema = 'public' and table_name = ${table}
     order by column_name
  `
}

describe('the migrations build the schema the code expects', () => {
  it('runs every file in this directory', async () => {
    // Guards the setup itself: a renamed or mis-sorted directory would migrate
    // nothing and leave every assertion below to fail with a confusing
    // "relation does not exist" instead of naming the real problem.
    const files = await migrationFiles()

    expect(files).toEqual([
      '0000_initial.sql',
      '0001_outbox.sql',
      '0002_todo_version.sql',
      '0003_uploads.sql',
    ])
  })

  it.each(ALL_TABLES)('creates %s', async (table) => {
    const [row] = await connection.sql<{ count: number }[]>`
      select count(*)::int as count
        from information_schema.tables
       where table_schema = 'public' and table_name = ${table}
    `

    expect(row?.count).toBe(1)
  })

  /**
   * The columns, compared by name, SQL type and nullability against what
   * Drizzle declares — because "the table exists" is the easy half. A column
   * added to `schema.ts` and left out of a migration produces a
   * `column … does not exist` at run time on whichever request first selects
   * it, which in a `select *` built from the schema is every request touching
   * that table.
   *
   * `getTableConfig` is Drizzle's own reflection over the table it will build
   * its SQL from, so this compares the two artefacts that actually disagree
   * rather than a hand-written list that would need updating alongside both.
   */
  it.each([
    ['todos', todos],
    ['uploads', uploads],
    ['outbox', outbox],
  ] as const)('gives %s every column the schema declares', async (name, table) => {
    const declared = getTableConfig(table)
      .columns.map((column) => ({
        column_name: column.name,
        data_type: column.getSQLType(),
        is_nullable: column.notNull ? ('NO' as const) : ('YES' as const),
      }))
      .sort((a, b) => a.column_name.localeCompare(b.column_name))

    expect(await columnsOf(name)).toEqual(declared)
  })

  it('creates the partial index the outbox claim runs on', async () => {
    const [row] = await connection.sql<{ indexdef: string }[]>`
      select indexdef from pg_indexes
       where schemaname = 'public' and indexname = 'outbox_pending_idx'
    `

    // The predicate is the whole point of the index: without it the index grows
    // with the delivered history rather than with the backlog. An index that
    // exists but has lost its `WHERE` is a performance regression nothing else
    // in this repository would notice.
    expect(row?.indexdef).toContain('WHERE')
    expect(row?.indexdef).toContain('published_at IS NULL')
    expect(row?.indexdef).toContain('failed_at IS NULL')
  })

  it('makes key unique on uploads', async () => {
    // `schema.ts` declares `.unique()` and the column comparison above cannot
    // see a constraint. Asserted through the behaviour rather than the catalog,
    // because what the route depends on is the second insert failing.
    const row = {
      key: 'uploads/fake-object-key.txt',
      filename: 'fake-object.txt',
      contentType: 'text/plain',
      size: 11,
      url: 'https://example.invalid/uploads/fake-object-key.txt',
    }

    await connection.db.insert(uploads).values(row)

    const duplicate = await connection.db
      .insert(uploads)
      .values({ ...row, filename: 'a-different-name.txt' })
      .then(() => undefined)
      .catch((error: unknown) => error)

    // 23505 is `unique_violation`.
    expect(sqlState(duplicate)).toBe('23505')
  })

  /**
   * Every table read through the query builder the application uses.
   *
   * A `select *` that Drizzle assembles from `schema.ts` names each column
   * explicitly, so this is the cheapest possible end-to-end check that the two
   * agree — and unlike the catalog comparison above it fails the way production
   * would, with the driver's own error.
   */
  it.each([
    ['todos', todos],
    ['uploads', uploads],
    ['outbox', outbox],
  ] as const)('can be queried through Drizzle: %s', async (_name, table) => {
    await expect(connection.db.select().from(table).limit(1)).resolves.toEqual([])
  })

  it('is re-runnable over an already-migrated database', async () => {
    // Every statement in this directory is `IF NOT EXISTS`, which is a claim
    // worth checking: a migration that is not idempotent turns a re-run — a
    // retried deploy, a second developer's `db:migrate` — into an outage, and
    // the failure is at the point of deploy rather than at the point of change.
    await expect(applyMigrations(connection.sql)).resolves.toEqual(await migrationFiles())
  })
})
