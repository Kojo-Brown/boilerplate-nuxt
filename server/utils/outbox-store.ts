import { and, eq, inArray, isNull, lte, sql } from 'drizzle-orm'
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core'

import type * as schema from '~/server/db/schema'
import { outbox, type NewOutboxRow, type OutboxRow } from '~/server/db/schema'
import type { OutboxMessage, OutboxRecord, OutboxStore } from '~/server/utils/outbox'

/**
 * The Drizzle half of the outbox: the four statements the relay runs, and the
 * insert a request handler runs inside its own transaction.
 *
 * `server/utils/outbox.ts` holds the rules and depends on nothing but the
 * {@link OutboxStore} port. This file is the part that speaks SQL. It is the
 * same split as `idempotency.ts` / `idempotent-route.ts`, with one difference
 * worth noting: this half is unit-tested too. Drizzle's `pg-proxy` driver takes
 * a callback in place of a connection, so a test drives a **real** Drizzle
 * instance and reads the exact SQL and parameters it emits — see
 * `tests/unit/server/outbox-store.test.ts`.
 *
 * That matters most for the claim. `FOR UPDATE SKIP LOCKED` is the reason two
 * relays can poll the same table safely, and it is invisible from the outside:
 * a claim missing it still passes every functional test on one process and
 * starts double-publishing the moment a second one is deployed.
 */

/**
 * Any Drizzle Postgres database — or transaction.
 *
 * Deliberately the base class rather than `Database` from
 * `server/utils/db.ts`. A `PgTransaction` extends `PgDatabase` too, so
 * {@link enqueueOutbox} takes the `tx` handed to a `db.transaction()` callback
 * without a cast, which is the whole point: an outbox row written on the
 * connection instead of on the transaction would commit even when the change it
 * describes rolled back, and it is a one-character mistake to make.
 *
 * The query-result parameter is left as the base `PgQueryResultHKT` rather than
 * `postgres-js`'s own, which is what lets a test drive these statements through
 * Drizzle's `pg-proxy` driver — a different result type, the same SQL.
 */
export type OutboxDatabase = PgDatabase<PgQueryResultHKT, typeof schema>

/**
 * Turns a message into the row to insert.
 *
 * Everything else is a column default: `attempts` starts at zero,
 * `available_at` and `created_at` at `now()` — the transaction's `now()`, so
 * rows from one transaction sort by insertion order rather than by however long
 * each statement took.
 */
export function toOutboxInsert(message: OutboxMessage): NewOutboxRow {
  return {
    aggregateType: message.aggregateType,
    aggregateId: message.aggregateId,
    eventType: message.eventType,
    payload: message.payload,
  }
}

/** Maps a claimed row to what a publisher sees. */
export function toOutboxRecord(row: OutboxRow): OutboxRecord {
  return {
    id: row.id,
    aggregateType: row.aggregateType,
    aggregateId: row.aggregateId,
    eventType: row.eventType,
    payload: row.payload,
    attempts: row.attempts,
    createdAt: row.createdAt,
  }
}

/**
 * Writes outbox rows on the transaction that is making the change.
 *
 * ```ts
 * await db.transaction(async (tx) => {
 *   const [todo] = await tx.insert(todos).values({ title }).returning()
 *   await enqueueOutbox(tx, [todoCreatedMessage(todo)])
 * })
 * ```
 *
 * Pass the `tx`, never `useDb()`. The type will not stop you — a `Database` is
 * an `OutboxDatabase` as well — but a row written outside the transaction is an
 * event announcing a change that may never commit, which is the failure the
 * outbox exists to prevent, reintroduced from the inside.
 *
 * Empty input is a no-op rather than an empty `INSERT`, which Postgres rejects.
 */
export async function enqueueOutbox(
  db: OutboxDatabase,
  messages: readonly OutboxMessage[],
): Promise<void> {
  if (messages.length === 0) return
  await db.insert(outbox).values(messages.map(toOutboxInsert))
}

/**
 * The claim: take up to `limit` due rows, and hold them for `leaseMs`.
 *
 * One statement, because it has to be atomic against every other relay:
 *
 * ```sql
 * UPDATE outbox SET attempts = attempts + 1, available_at = $lease
 *  WHERE id IN (SELECT id FROM outbox
 *                WHERE published_at IS NULL AND failed_at IS NULL
 *                  AND available_at <= $now
 *                ORDER BY available_at, created_at
 *                LIMIT $limit
 *                  FOR UPDATE SKIP LOCKED)
 * RETURNING *
 * ```
 *
 * `FOR UPDATE` locks the rows the subquery selected; `SKIP LOCKED` makes a
 * competing relay step over them and take the next ones instead of blocking
 * behind a lock held for the length of somebody else's HTTP request. Without the
 * pair, the two relays either serialise the whole queue or claim the same rows.
 *
 * Pushing `available_at` out to `now + leaseMs` in the same statement is what
 * makes the claim survivable: the row is not "locked" once the statement
 * commits, it is merely *not due yet*, so a relay that is killed mid-publish
 * releases it by expiry with nothing left to clean up.
 *
 * `ORDER BY available_at, created_at` puts retries in their scheduled place
 * rather than always at the front — ordering by `created_at` alone would let one
 * failing old row take a slot in every batch.
 */
export function claimStatement(
  db: OutboxDatabase,
  input: { readonly limit: number; readonly now: Date; readonly leaseMs: number },
) {
  const due = db
    .select({ id: outbox.id })
    .from(outbox)
    .where(
      and(isNull(outbox.publishedAt), isNull(outbox.failedAt), lte(outbox.availableAt, input.now)),
    )
    .orderBy(outbox.availableAt, outbox.createdAt)
    .limit(input.limit)
    .for('update', { skipLocked: true })

  return db
    .update(outbox)
    .set({
      // Incremented in SQL rather than from the row we read, so two relays
      // racing on a row the lease has already released cannot both write the
      // same number — see the "attempts count claims" note in `outbox.ts`.
      attempts: sql`${outbox.attempts} + 1`,
      availableAt: new Date(input.now.getTime() + input.leaseMs),
    })
    .where(inArray(outbox.id, due))
    .returning()
}

/**
 * Records a delivery.
 *
 * `last_error` is cleared, so a row that failed twice and then succeeded does
 * not keep a stale error beside a `published_at`. `attempts` is left as it is —
 * it is how many tries the delivery took, which is worth keeping.
 *
 * The `WHERE` re-checks `published_at IS NULL` so a second relay that claimed
 * the row after a lease expiry cannot overwrite the first delivery's timestamp.
 */
export function markPublishedStatement(
  db: OutboxDatabase,
  input: { readonly id: string; readonly now: Date },
) {
  return db
    .update(outbox)
    .set({ publishedAt: input.now, lastError: null })
    .where(and(eq(outbox.id, input.id), isNull(outbox.publishedAt)))
}

/** Puts a failed row back on the queue, with the reason. */
export function rescheduleStatement(
  db: OutboxDatabase,
  input: { readonly id: string; readonly availableAt: Date; readonly lastError: string },
) {
  return db
    .update(outbox)
    .set({ availableAt: input.availableAt, lastError: input.lastError })
    .where(and(eq(outbox.id, input.id), isNull(outbox.publishedAt)))
}

/**
 * Gives up on a row.
 *
 * `failed_at` takes it out of the partial index the claim runs on, so a dead
 * letter costs nothing to skip. The row itself stays: it is the only record that
 * an event was owed and never delivered, and the payload is what an operator
 * needs to replay it by hand.
 */
export function deadLetterStatement(
  db: OutboxDatabase,
  input: { readonly id: string; readonly now: Date; readonly lastError: string },
) {
  return db
    .update(outbox)
    .set({ failedAt: input.now, lastError: input.lastError })
    .where(and(eq(outbox.id, input.id), isNull(outbox.publishedAt)))
}

/** Binds the statements above to a database as the port the relay expects. */
export function createDrizzleOutboxStore(db: OutboxDatabase): OutboxStore {
  return {
    async claim(input) {
      const rows = await claimStatement(db, input)
      return rows.map(toOutboxRecord)
    },
    async markPublished(input) {
      await markPublishedStatement(db, input)
    },
    async reschedule(input) {
      await rescheduleStatement(db, input)
    },
    async deadLetter(input) {
      await deadLetterStatement(db, input)
    },
  }
}
