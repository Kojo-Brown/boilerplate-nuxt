import { drizzle } from 'drizzle-orm/pg-proxy'
import { beforeEach, describe, expect, it } from 'vitest'

import * as schema from '~/server/db/schema'
import {
  claimStatement,
  createDrizzleOutboxStore,
  deadLetterStatement,
  enqueueOutbox,
  markPublishedStatement,
  rescheduleStatement,
  toOutboxInsert,
  toOutboxRecord,
  type OutboxDatabase,
} from '~/server/utils/outbox-store'

/**
 * A real Drizzle instance whose transport is a function, not a mock of Drizzle.
 *
 * `drizzle-orm/pg-proxy` takes a callback in place of a connection, so these
 * tests exercise the actual query builder — the same code path a `postgres-js`
 * database runs — and read the SQL and parameters it produces. What that buys
 * over asserting on a hand-rolled fake is the one property that matters most
 * here and is invisible from every other angle: a claim without `FOR UPDATE SKIP
 * LOCKED` behaves identically on one process and starts double-publishing the
 * day a second instance is deployed. There is no functional test on a single
 * connection that can tell the two apart.
 *
 * What this cannot cover is Postgres actually honouring the lock, and the
 * transaction the routes wrap these calls in — pg-proxy refuses `transaction()`
 * outright. Those want a live database; `SPEC.md` has Testcontainers as its own
 * item, and `docs/outbox.md` says plainly which claims rest on which.
 */
interface Captured {
  readonly sql: string
  readonly params: readonly unknown[]
}

interface Harness {
  readonly db: OutboxDatabase
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
      // pg-proxy hands rows to Drizzle **positionally** — the driver contract is
      // an array of values per row, in the order the query selected them, and
      // Drizzle maps them onto column names itself. Returning objects gets every
      // field back as `undefined` with no error, so the seeded rows are declared
      // in schema order and flattened here.
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

/**
 * A row as the driver hands it back: timestamps are strings, not Dates.
 *
 * Key order is load-bearing — see the note in `createHarness` — so it matches
 * the column order in `server/db/schema.ts`, which is the order `RETURNING *`
 * emits.
 */
const DRIVER_ROW = {
  id: '11111111-1111-4111-8111-111111111111',
  aggregate_type: 'todo',
  aggregate_id: '22222222-2222-4222-8222-222222222222',
  event_type: 'todo.created',
  payload: { id: '22222222-2222-4222-8222-222222222222', title: 'Write the relay' },
  attempts: 1,
  available_at: '2026-01-01T00:00:30.000Z',
  created_at: '2025-12-31T23:59:59.000Z',
  published_at: null,
  failed_at: null,
  last_error: null,
}

let harness: Harness

beforeEach(() => {
  harness = createHarness()
})

describe('toOutboxInsert', () => {
  it('carries the message and leaves the delivery state to column defaults', () => {
    expect(
      toOutboxInsert({
        aggregateType: 'todo',
        aggregateId: 't1',
        eventType: 'todo.created',
        payload: { id: 't1' },
      }),
    ).toEqual({
      aggregateType: 'todo',
      aggregateId: 't1',
      eventType: 'todo.created',
      payload: { id: 't1' },
    })
  })
})

describe('toOutboxRecord', () => {
  it('projects a row to what a publisher sees, and nothing more', () => {
    const record = toOutboxRecord({
      id: 'row-1',
      aggregateType: 'todo',
      aggregateId: 't1',
      eventType: 'todo.created',
      payload: { id: 't1' },
      attempts: 2,
      availableAt: NOW,
      createdAt: NOW,
      publishedAt: null,
      failedAt: null,
      lastError: 'Error: nope',
    })

    // The bookkeeping columns stay behind: a publisher has no business seeing
    // `last_error`, and an envelope built from a record cannot leak one.
    expect(record).toEqual({
      id: 'row-1',
      aggregateType: 'todo',
      aggregateId: 't1',
      eventType: 'todo.created',
      payload: { id: 't1' },
      attempts: 2,
      createdAt: NOW,
    })
  })
})

describe('enqueueOutbox', () => {
  it('inserts one row per message', async () => {
    await enqueueOutbox(harness.db, [
      {
        aggregateType: 'todo',
        aggregateId: 't1',
        eventType: 'todo.created',
        payload: { id: 't1' },
      },
      {
        aggregateType: 'todo',
        aggregateId: 't2',
        eventType: 'todo.deleted',
        payload: { id: 't2' },
      },
    ])

    const { sql, params } = harness.last()
    expect(sql).toContain('insert into "outbox"')
    expect(sql).toContain('"aggregate_type", "aggregate_id", "event_type", "payload"')
    expect(params).toEqual([
      'todo',
      't1',
      'todo.created',
      '{"id":"t1"}',
      'todo',
      't2',
      'todo.deleted',
      '{"id":"t2"}',
    ])
  })

  it('issues no statement at all for an empty list', async () => {
    // Postgres rejects an INSERT with no VALUES, and a handler with nothing to
    // announce is an ordinary case, not an error.
    await enqueueOutbox(harness.db, [])
    expect(harness.calls).toHaveLength(0)
  })
})

describe('claimStatement', () => {
  it('claims only rows that are owed and due', async () => {
    await claimStatement(harness.db, { limit: 20, now: NOW, leaseMs: 30_000 })

    const { sql } = harness.last()
    expect(sql).toContain('"outbox"."published_at" is null')
    expect(sql).toContain('"outbox"."failed_at" is null')
    expect(sql).toContain('"outbox"."available_at" <= $')
  })

  it('locks the batch with SKIP LOCKED so relays divide the queue', async () => {
    await claimStatement(harness.db, { limit: 20, now: NOW, leaseMs: 30_000 })

    // The assertion this whole file exists for. Without `for update`, two relays
    // claim the same rows; without `skip locked`, the second blocks behind the
    // first for the length of an HTTP request.
    expect(harness.last().sql).toContain('for update skip locked')
  })

  it('orders by available_at then created_at', async () => {
    await claimStatement(harness.db, { limit: 20, now: NOW, leaseMs: 30_000 })

    // `created_at` alone would let one failing old row take a slot in every
    // batch, ahead of rows that are actually due.
    expect(harness.last().sql).toContain(
      'order by "outbox"."available_at", "outbox"."created_at" limit $',
    )
  })

  it('increments attempts in SQL and pushes availability out by the lease', async () => {
    await claimStatement(harness.db, { limit: 7, now: NOW, leaseMs: 30_000 })

    const { sql, params } = harness.last()
    expect(sql).toContain('set "attempts" = "outbox"."attempts" + 1')
    // Lease first (the SET), then the due cutoff (the WHERE), then the limit.
    expect(params).toEqual(['2026-01-01T00:00:30.000Z', '2026-01-01T00:00:00.000Z', 7])
  })

  it('returns the claimed rows, mapped', async () => {
    harness.responses.push([DRIVER_ROW])

    const rows = await claimStatement(harness.db, { limit: 1, now: NOW, leaseMs: 30_000 })

    expect(rows).toHaveLength(1)
    expect(rows[0]?.attempts).toBe(1)
    expect(rows[0]?.payload).toEqual(DRIVER_ROW.payload)
    // Drizzle parses the driver's timestamp string, so a record carries a Date.
    expect(rows[0]?.createdAt).toBeInstanceOf(Date)
  })
})

describe('markPublishedStatement', () => {
  it('stamps the delivery, clears the error, and cannot overwrite an earlier one', async () => {
    await markPublishedStatement(harness.db, { id: 'row-1', now: NOW })

    const { sql, params } = harness.last()
    expect(sql).toContain('set "published_at" = $1, "last_error" = $2')
    // The re-check is what stops a relay that took the row after a lease expiry
    // from overwriting the first delivery's timestamp.
    expect(sql).toContain('"outbox"."published_at" is null')
    expect(params).toEqual(['2026-01-01T00:00:00.000Z', null, 'row-1'])
  })
})

describe('rescheduleStatement', () => {
  it('moves the row to its next attempt with the reason', async () => {
    const availableAt = new Date(NOW.getTime() + 4_000)
    await rescheduleStatement(harness.db, {
      id: 'row-1',
      availableAt,
      lastError: 'Error: consumer down',
    })

    const { sql, params } = harness.last()
    expect(sql).toContain('set "available_at" = $1, "last_error" = $2')
    expect(params).toEqual(['2026-01-01T00:00:04.000Z', 'Error: consumer down', 'row-1'])
  })
})

describe('deadLetterStatement', () => {
  it('sets failed_at, which takes the row out of the partial index', async () => {
    await deadLetterStatement(harness.db, { id: 'row-1', now: NOW, lastError: 'Error: gave up' })

    const { sql, params } = harness.last()
    expect(sql).toContain('set "failed_at" = $1, "last_error" = $2')
    // Not a delete: the row is the only record that an event was owed and never
    // delivered, and its payload is what an operator replays by hand.
    expect(sql).toContain('update "outbox"')
    expect(params).toEqual(['2026-01-01T00:00:00.000Z', 'Error: gave up', 'row-1'])
  })
})

describe('createDrizzleOutboxStore', () => {
  it('satisfies the port the relay depends on', async () => {
    const store = createDrizzleOutboxStore(harness.db)
    harness.responses.push([DRIVER_ROW])

    const claimed = await store.claim({ limit: 5, now: NOW, leaseMs: 30_000 })
    expect(claimed.map((record) => record.id)).toEqual([DRIVER_ROW.id])

    await store.markPublished({ id: DRIVER_ROW.id, now: NOW })
    await store.reschedule({ id: DRIVER_ROW.id, availableAt: NOW, lastError: 'e' })
    await store.deadLetter({ id: DRIVER_ROW.id, now: NOW, lastError: 'e' })

    expect(harness.calls.map((call) => call.sql.slice(0, 6))).toEqual([
      'update',
      'update',
      'update',
      'update',
    ])
  })
})
