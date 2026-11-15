import type { ExtractTablesWithRelations } from 'drizzle-orm'
import type { PgTransaction } from 'drizzle-orm/pg-core'
import {
  drizzle,
  type PostgresJsDatabase,
  type PostgresJsQueryResultHKT,
} from 'drizzle-orm/postgres-js'
import postgres, { type Sql } from 'postgres'
import { inject } from 'vitest'

import * as schema from '~/server/db/schema'

/** Drizzle bound to this project's schema over a `postgres-js` connection. */
export type TestDatabase = PostgresJsDatabase<typeof schema>

/** The handle `db.transaction()` hands its callback. */
export type TestTransaction = PgTransaction<
  PostgresJsQueryResultHKT,
  typeof schema,
  ExtractTablesWithRelations<typeof schema>
>

/** Everything a suite needs to talk to the container, plus how to let go of it. */
export interface TestConnection {
  /** Drizzle, bound to this connection and the project's schema. */
  readonly db: TestDatabase
  /** The raw client, for catalog queries and `pg_stat_activity` probes. */
  readonly sql: Sql
  /** This connection's backend pid — the handle for "is it blocked?". */
  readonly pid: number
  readonly close: () => Promise<void>
}

/**
 * Opens one connection to the run's Postgres.
 *
 * `max: 1` on every client, which is the property the concurrency tests rest
 * on. A pool would hand the two halves of an interleaving two different
 * backends — or the same one, depending on timing — and a test that says "this
 * transaction holds the row" would be holding it on a connection nobody can
 * name. One connection per client means a client *is* a session: two sessions is
 * two `connect()` calls, and nothing is left to the pool's discretion.
 *
 * `onnotice` is silenced because `CREATE TABLE IF NOT EXISTS` and friends emit
 * one notice per object that already exists, and the migration re-run test would
 * otherwise print a paragraph of them.
 */
export async function connect(): Promise<TestConnection> {
  const sql = postgres(inject('databaseUrl'), { max: 1, onnotice: () => {} })
  const [row] = await sql<{ pid: number }[]>`select pg_backend_pid() as pid`

  if (row === undefined) throw new Error('pg_backend_pid() returned no row')

  return {
    db: drizzle(sql, { schema }),
    sql,
    pid: row.pid,
    close: () => sql.end(),
  }
}

/** Every table the schema declares, in an order no foreign key objects to. */
export const ALL_TABLES = ['todos', 'uploads', 'outbox'] as const

/**
 * Empties every table.
 *
 * In `beforeEach`, not `afterEach`: a suite that cleans up after itself leaves
 * the database dirty whenever it fails, and the next failure is then somebody
 * debugging leftovers from the first. Cleaning before means a suite always
 * starts from the same state, whatever the suite before it did or did not
 * finish.
 */
export async function truncateAll(sql: Sql): Promise<void> {
  await sql.unsafe(`truncate table ${ALL_TABLES.map((table) => `"${table}"`).join(', ')} cascade`)
}

/**
 * The SQLSTATE a Postgres error carries, if it is one.
 *
 * Drizzle re-throws with its own message — `Failed query: …` — and keeps the
 * driver's error as `cause`. Matching on the message would be matching on
 * Drizzle's formatting; the SQLSTATE is Postgres' own, is five characters, and
 * is in the standard.
 */
export function sqlState(error: unknown): string | undefined {
  const cause: unknown = error instanceof Error ? error.cause : undefined
  return typeof cause === 'object' && cause !== null && 'code' in cause
    ? String((cause as { code: unknown }).code)
    : undefined
}

interface Deferred<T> {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
  readonly reject: (reason: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => {}
  let reject: (reason: unknown) => void = () => {}
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })

  return { promise, resolve, reject }
}

/** A transaction that is open, has run its first statements, and has not committed. */
export interface HeldTransaction<T> {
  /** What the body returned. Settled by the time this object exists. */
  readonly value: Promise<T>
  /** Commits, and resolves once the transaction is really over. */
  readonly commit: () => Promise<void>
  /** Rolls back, and resolves once the transaction is really over. */
  readonly rollback: () => Promise<void>
}

class Rollback extends Error {}

/**
 * Runs `body` inside a transaction and then **holds that transaction open**
 * until the caller commits or rolls back.
 *
 * This is the shape every interesting concurrency test needs, and the one a
 * plain `db.transaction(async (tx) => …)` cannot express: the locks a statement
 * takes are released at commit, so "another session finds this row locked" is
 * only observable while somebody is deliberately not committing yet.
 *
 * The body's result is exposed as a promise rather than returned, because this
 * function returns while the transaction is still open.
 *
 * **The holding connection is occupied for the duration.** Every client here is
 * `max: 1`, so a query sent to the same `TestConnection` while it holds a
 * transaction does not run concurrently with it — it queues behind it, and if
 * the thing that would release the transaction is further down the same test,
 * the suite deadlocks rather than fails. Observe a held row from another
 * connection.
 *
 * `releaseAfterMs` is the guard against the other way a suite stops dead: an
 * assertion that throws between `hold` and `commit` would otherwise leave the
 * transaction open, and the next `beforeEach` truncate would wait on its locks
 * forever. One test failing should cost one test.
 */
export async function hold<T>(
  db: TestDatabase,
  body: (tx: TestTransaction) => Promise<T>,
  releaseAfterMs = 20_000,
): Promise<HeldTransaction<T>> {
  // `undefined` rather than `void`: these two carry no value, and a
  // `Deferred<void>` would give `resolve` a `void` parameter, which is not a
  // thing a caller can pass.
  const gate = deferred<undefined>()
  const value = deferred<T>()
  const ran = deferred<undefined>()

  const finished = db
    .transaction(async (tx) => {
      try {
        value.resolve(await body(tx))
      } catch (error) {
        value.reject(error)
        throw error
      } finally {
        ran.resolve(undefined)
      }

      // Resolved by `commit`, rejected by `rollback` — and postgres-js rolls a
      // transaction back exactly when its callback throws.
      await gate.promise
    })
    .catch((error: unknown) => {
      if (!(error instanceof Rollback)) throw error
    })

  // Nothing awaits `value` until the caller does, and a body that threw would
  // otherwise be an unhandled rejection in the meantime.
  value.promise.catch(() => {})

  await ran.promise

  const abandoned = setTimeout(() => {
    gate.reject(new Rollback('held transaction was never released'))
  }, releaseAfterMs)
  // Not a reason to keep the process alive once the suite is over.
  abandoned.unref()

  return {
    value: value.promise,
    commit: async () => {
      clearTimeout(abandoned)
      gate.resolve(undefined)
      await finished
    },
    rollback: async () => {
      clearTimeout(abandoned)
      gate.reject(new Rollback('held transaction rolled back'))
      await finished
    },
  }
}

/**
 * Waits until the backend `pid` is parked on a lock.
 *
 * The alternative is a `setTimeout` long enough to "probably" be blocked, which
 * is how a suite becomes flaky on a loaded CI runner: too short and the test
 * asserts an interleaving that never happened, too long and every run pays for
 * it. Postgres already knows the answer — `wait_event_type = 'Lock'` is the
 * backend saying it is waiting on one — so this polls for the fact itself.
 *
 * `probe` must be a **third** connection. Asking the blocked session whether it
 * is blocked cannot work — its one connection is busy being blocked — and the
 * failure is not obvious from the outside, so it is checked rather than
 * documented: the probe reports its own pid alongside the answer.
 */
export async function waitUntilBlocked(probe: Sql, pid: number, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs

  for (;;) {
    const [row] = await probe<{ blocked: boolean; self: boolean }[]>`
      select wait_event_type = 'Lock' as blocked, pg_backend_pid() = ${pid} as self
        from pg_stat_activity
       where pid = ${pid}
    `

    if (row?.self === true) {
      throw new Error(`backend ${pid} cannot probe itself — pass a third connection`)
    }
    if (row?.blocked === true) return
    if (Date.now() > deadline) throw new Error(`backend ${pid} never blocked on a lock`)

    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}
