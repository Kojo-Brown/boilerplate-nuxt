import { drizzle } from 'drizzle-orm/pg-proxy'
import { describe, expect, it } from 'vitest'

import * as schema from '~/server/db/schema'
import {
  readConflict,
  todoByIdStatement,
  todoDeleteStatement,
  todoUpdateStatement,
  type TodoDatabase,
} from '~/server/utils/todo-store'

/**
 * A real Drizzle instance whose transport is a function, not a mock of Drizzle.
 *
 * Same harness as `outbox-store.test.ts`, for the same reason. The property that
 * matters here is invisible from the outside: an `UPDATE` that forgets
 * `AND version = $expected` behaves identically to a correct one on a single
 * connection, passes every functional test, and starts losing writes the day two
 * people edit the same todo. Reading the emitted SQL is the only way to tell the
 * two apart without a second database connection.
 *
 * What this cannot cover is Postgres honouring the predicate, and the
 * transaction the routes wrap these statements in — pg-proxy refuses
 * `transaction()` outright. `docs/optimistic-concurrency.md` says which claims
 * rest on which, and records the two-session check that was run by hand.
 */
interface Captured {
  readonly sql: string
  readonly params: readonly unknown[]
}

interface Harness {
  readonly db: TodoDatabase
  readonly calls: Captured[]
  /** Rows the next query returns, shifted one call at a time. */
  readonly responses: Record<string, unknown>[][]
  readonly last: () => Captured
}

function createHarness(): Harness {
  const calls: Captured[] = []
  const responses: Record<string, unknown>[][] = []

  const db = drizzle(
    (sql, params) => {
      calls.push({ sql, params })
      // pg-proxy hands rows to Drizzle **positionally**: the driver contract is
      // an array of values per row, in the order the query selected them.
      // Returning objects gets every field back as `undefined` with no error, so
      // the seeded rows are declared in schema order and flattened here.
      const rows = responses.shift() ?? []
      return Promise.resolve({ rows: rows.map((row) => Object.values(row)) })
    },
    { schema },
  )

  return {
    db,
    calls,
    responses,
    last: () => {
      const call = calls.at(-1)
      if (!call) throw new Error('Test bug: no query was issued')
      return call
    },
  }
}

const NOW = new Date('2026-01-01T00:00:00.000Z')
const ID = '11111111-1111-1111-1111-111111111111'

/** A row as the driver hands it back, in schema order. */
function todoRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: ID,
    title: 'shared todo',
    completed: false,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    version: 1,
    ...overrides,
  }
}

describe('todoUpdateStatement', () => {
  it('guards the update on the expected version, in the WHERE clause', async () => {
    const harness = createHarness()

    await todoUpdateStatement(harness.db, {
      id: ID,
      expected: 4,
      values: { completed: true },
      now: NOW,
    })

    const { sql, params } = harness.last()
    expect(sql).toContain('update "todos"')
    // The guard and the write are one statement. A `SELECT`, a comparison in
    // TypeScript and then an `UPDATE` would read as correct and would move the
    // race rather than close it.
    expect(sql).toMatch(/where .*"todos"\."id" = \$\d+ and "todos"\."version" = \$\d+/i)
    expect(params).toContain(4)
  })

  it('computes the bump in SQL rather than from the value it was handed', async () => {
    const harness = createHarness()

    await todoUpdateStatement(harness.db, {
      id: ID,
      expected: 4,
      values: { completed: true },
      now: NOW,
    })

    const { sql, params } = harness.last()
    // `version = "todos"."version" + 1`, not `version = $5` with 5 in params.
    // Writing `expected + 1` is correct only because the WHERE pinned the row —
    // a coincidence that stops holding as soon as an unguarded caller appears.
    expect(sql).toMatch(/"version" = "todos"\."version" \+ 1/i)
    expect(params).not.toContain(5)
  })

  it('sets the columns it was asked for and the timestamp it was given', async () => {
    const harness = createHarness()

    await todoUpdateStatement(harness.db, {
      id: ID,
      expected: 1,
      values: { title: 'renamed', completed: true },
      now: NOW,
    })

    const { sql, params } = harness.last()
    expect(sql).toContain('"title"')
    expect(sql).toContain('"completed"')
    expect(sql).toContain('"updated_at"')
    expect(params).toContain('renamed')
    // Passed in rather than `now()`, which in Postgres is the transaction's
    // start time and so cannot distinguish two writes in one transaction.
    expect(params).toContain(NOW.toISOString())
  })

  it('returns the updated row, so the route never re-reads to find the version', async () => {
    const harness = createHarness()
    harness.responses.push([todoRow({ version: 5, completed: true })])

    const [row] = await todoUpdateStatement(harness.db, {
      id: ID,
      expected: 4,
      values: { completed: true },
      now: NOW,
    })

    expect(harness.last().sql).toContain('returning')
    expect(row?.version).toBe(5)
  })

  it('drops the version predicate for If-Match: *, keeping the id predicate', async () => {
    const harness = createHarness()

    await todoUpdateStatement(harness.db, {
      id: ID,
      expected: null,
      values: { completed: true },
      now: NOW,
    })

    const { sql } = harness.last()
    expect(sql).toContain('"todos"."id" = $')
    expect(sql).not.toMatch(/where .*"todos"\."version" = \$/i)
  })

  it('matches no row when nothing was written — the shape a conflict arrives in', async () => {
    const harness = createHarness()
    harness.responses.push([])

    const rows = await todoUpdateStatement(harness.db, {
      id: ID,
      expected: 4,
      values: { completed: true },
      now: NOW,
    })

    expect(rows).toEqual([])
  })
})

describe('todoDeleteStatement', () => {
  it('guards the delete on the expected version too', async () => {
    const harness = createHarness()

    await todoDeleteStatement(harness.db, { id: ID, expected: 3 })

    const { sql, params } = harness.last()
    expect(sql).toContain('delete from "todos"')
    expect(sql).toMatch(/where .*"todos"\."id" = \$\d+ and "todos"\."version" = \$\d+/i)
    expect(params).toContain(3)
  })

  it('returns the version it removed, so the event can carry it', async () => {
    const harness = createHarness()
    harness.responses.push([{ id: ID, version: 3 }])

    const [deleted] = await todoDeleteStatement(harness.db, { id: ID, expected: 3 })

    expect(harness.last().sql).toContain('returning')
    expect(deleted).toEqual({ id: ID, version: 3 })
  })

  it('drops the version predicate for If-Match: *', async () => {
    const harness = createHarness()

    await todoDeleteStatement(harness.db, { id: ID, expected: null })

    expect(harness.last().sql).not.toMatch(/where .*"version" = \$/i)
  })
})

describe('todoByIdStatement', () => {
  it('reads one row by id', async () => {
    const harness = createHarness()
    harness.responses.push([todoRow()])

    const [row] = await todoByIdStatement(harness.db, ID)

    const { sql, params } = harness.last()
    expect(sql).toContain('select')
    expect(sql).toContain('"todos"."id" = $')
    expect(params).toContain(ID)
    expect(row?.id).toBe(ID)
  })
})

describe('readConflict', () => {
  it('reports a row that moved on as stale, with the version it is at now', async () => {
    const harness = createHarness()
    harness.responses.push([todoRow({ version: 5 })])

    const { miss, current } = await readConflict(harness.db, ID)

    expect(miss).toEqual({ kind: 'stale', actual: 5 })
    expect(current?.version).toBe(5)
  })

  it('reports an absent row as missing, with no row to show', async () => {
    const harness = createHarness()
    harness.responses.push([])

    const { miss, current } = await readConflict(harness.db, ID)

    expect(miss).toEqual({ kind: 'missing' })
    expect(current).toBeNull()
  })

  it('answers both halves from one read', async () => {
    // Two reads would be two chances to see two different answers — the row can
    // be deleted between them, and the conflict UI would then be shown a version
    // that no longer exists either.
    const harness = createHarness()
    harness.responses.push([todoRow({ version: 2 })])

    await readConflict(harness.db, ID)

    expect(harness.calls).toHaveLength(1)
  })
})
