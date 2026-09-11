import { and, eq, sql } from 'drizzle-orm'
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core'

import type * as schema from '~/server/db/schema'
import { todos, type Todo } from '~/server/db/schema'
import type { WriteMiss } from '~/server/utils/optimistic-concurrency'

/**
 * The SQL half of optimistic concurrency on todos.
 *
 * `optimistic-concurrency.ts` holds the header rules with no database in them;
 * this file holds the statements, which are where the guarantee actually lives.
 * The statements are exported rather than inlined in the route handlers for the
 * same reason `outbox-store.ts` exports its claim: the property that matters is
 * invisible from the outside. An update that forgets `AND version = $expected`
 * passes every test that drives one request at a time, and starts losing writes
 * the day two people edit the same todo — so
 * `tests/unit/server/todo-store.test.ts` drives a real Drizzle instance through
 * the `pg-proxy` driver and reads the SQL these functions emit.
 */

/**
 * Any Drizzle Postgres database — or transaction.
 *
 * The base class, not `Database` from `server/utils/db.ts`, so a statement takes
 * the `tx` handed to a `db.transaction()` callback without a cast. The todo
 * routes need that: the update and its outbox row have to be one transaction.
 * Leaving the query-result parameter as the base `PgQueryResultHKT` is what lets
 * a test drive these through `pg-proxy` — a different result type, the same SQL.
 */
export type TodoDatabase = PgDatabase<PgQueryResultHKT, typeof schema>

/**
 * The columns a caller may set. `version` and `updatedAt` are not among them:
 * both are the statement's to decide, and a caller able to set either could
 * write a version the row never reached.
 *
 * `| undefined` on each, because `exactOptionalPropertyTypes` is on and the Zod
 * parse upstream produces exactly that — a partial with explicit `undefined`
 * for the fields the request left out.
 */
export interface TodoUpdateValues {
  readonly title?: string | undefined
  readonly completed?: boolean | undefined
}

/**
 * The version-guarded update.
 *
 * ```sql
 * UPDATE todos SET title = $1, updated_at = $2, version = todos.version + 1
 *  WHERE id = $3 AND version = $4
 * RETURNING *
 * ```
 *
 * Three things about that statement are load-bearing:
 *
 *  - **`AND version = $expected` is in the `WHERE`, not in TypeScript.** A
 *    handler that selects the row, compares versions, and then updates has moved
 *    the race rather than closed it — a competing transaction fits between the
 *    two statements. The comparison and the write have to be the same statement,
 *    and they are.
 *  - **`version = todos.version + 1` is computed in SQL.** Writing
 *    `version: expected + 1` from the value we were handed would be correct only
 *    because the `WHERE` already pinned the row to `expected` — a coincidence
 *    that stops holding the moment somebody adds an unguarded caller. Letting
 *    Postgres increment the column it holds makes the bump true by construction.
 *  - **`updated_at` is passed in rather than `now()`.** `now()` is the
 *    transaction's start time, so a handler that did two writes would stamp both
 *    with the same instant; passing a value makes the clock injectable, which is
 *    what the tests read.
 *
 * `expected` of `null` drops the version predicate — that is `If-Match: *`,
 * which asks only that the row exist. It is still one statement, so it still
 * cannot lose to a concurrent delete; it simply does not care which version it
 * overwrites.
 *
 * An empty `values` is not this function's problem to reject: the route rejects
 * it as a 400 before it gets here, because "no fields to update" is a request
 * the client got wrong, not a statement this file should quietly turn into a
 * version bump with no change.
 */
export function todoUpdateStatement(
  db: TodoDatabase,
  input: {
    readonly id: string
    readonly expected: number | null
    readonly values: TodoUpdateValues
    readonly now: Date
  },
) {
  const guard =
    input.expected === null
      ? eq(todos.id, input.id)
      : and(eq(todos.id, input.id), eq(todos.version, input.expected))

  return db
    .update(todos)
    .set({ ...input.values, updatedAt: input.now, version: sql`${todos.version} + 1` })
    .where(guard)
    .returning()
}

/**
 * The version-guarded delete.
 *
 * Deleting is the case where the guard is easiest to argue away — the row ends
 * up gone either way, so what does it matter which version went? It matters
 * because "delete this todo" and "delete the todo I was looking at" are
 * different requests, and only the second one is safe when somebody else has
 * since edited it into something the deleter never saw.
 *
 * `returning` the version as well as the id, because the route needs it to tell
 * a caller what it actually removed.
 */
export function todoDeleteStatement(
  db: TodoDatabase,
  input: { readonly id: string; readonly expected: number | null },
) {
  const guard =
    input.expected === null
      ? eq(todos.id, input.id)
      : and(eq(todos.id, input.id), eq(todos.version, input.expected))

  return db.delete(todos).where(guard).returning({ id: todos.id, version: todos.version })
}

/** Reads one todo by id. */
export function todoByIdStatement(db: TodoDatabase, id: string) {
  return db.select().from(todos).where(eq(todos.id, id)).limit(1)
}

/** Everything a route needs to answer a 412: why it missed, and with what. */
export interface ConflictContext {
  readonly miss: WriteMiss
  /** The row as it is now, or `null` when it has been deleted. */
  readonly current: Todo | null
}

/**
 * Works out why a guarded write matched no row, by re-reading it.
 *
 * Two outcomes, and the client does different things with each: `stale` means
 * the row moved on and there is something to merge against, `missing` means it
 * is gone and there is not. Both come from one read, because the row that
 * explains the miss is the same row the conflict UI has to render — asking for
 * it twice would be two chances to see two different answers.
 *
 * Run this **inside the same transaction as the failed write**. Outside it, the
 * re-read can observe a third state — somebody deleted the row between the
 * update and the select — and the client would be shown a conflict against a
 * version that no longer exists either. Inside, the transaction's snapshot is
 * the one the update ran against, so the answer describes the same instant the
 * conflict happened at.
 *
 * It is a second round trip on the failure path only, which is the path that is
 * already rare and already going to cost the user a decision.
 */
export async function readConflict(db: TodoDatabase, id: string): Promise<ConflictContext> {
  const [current] = await todoByIdStatement(db, id)

  return current === undefined
    ? { miss: { kind: 'missing' }, current: null }
    : { miss: { kind: 'stale', actual: current.version }, current }
}
