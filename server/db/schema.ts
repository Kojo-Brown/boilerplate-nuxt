import { sql } from 'drizzle-orm'
import { boolean, index, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'

export const todos = pgTable('todos', {
  id: uuid('id').primaryKey().defaultRandom(),
  title: text('title').notNull(),
  completed: boolean('completed').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export type Todo = typeof todos.$inferSelect
export type NewTodo = typeof todos.$inferInsert

export const uploads = pgTable('uploads', {
  id: uuid('id').primaryKey().defaultRandom(),
  key: text('key').notNull().unique(),
  filename: text('filename').notNull(),
  contentType: text('content_type').notNull(),
  size: integer('size').notNull(),
  url: text('url').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export type Upload = typeof uploads.$inferSelect
export type NewUpload = typeof uploads.$inferInsert

/**
 * The transactional outbox — see `server/utils/outbox.ts` and `docs/outbox.md`.
 *
 * A row is written inside the same transaction as the change it describes, so
 * "the todo exists" and "somebody will hear about the todo" commit or roll back
 * together. `server/plugins/outbox-relay.ts` publishes the rows afterwards.
 *
 * ## Why the delivery state is columns on this table
 *
 * `attempts`, `available_at`, `published_at`, `failed_at` and `last_error` are
 * the relay's bookkeeping, and they live beside the payload rather than in a
 * separate table because the claim has to be one statement: the relay takes a
 * batch with `UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED)`, and a
 * join across two tables would need a lock on both to mean the same thing.
 *
 * A published row is kept, not deleted. It is the audit trail of what was
 * emitted, and deleting on success would make "no row" mean both "delivered" and
 * "never enqueued". Pruning is an operator's retention decision, not the relay's
 * — `docs/outbox.md` has the statement.
 */
export const outbox = pgTable(
  'outbox',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** The kind of thing that changed — `todo`. Namespaces `aggregate_id`. */
    aggregateType: text('aggregate_type').notNull(),
    /** The id of the row that changed. Text, not uuid: not every key is one. */
    aggregateId: text('aggregate_id').notNull(),
    /** Past tense, `<aggregate>.<verb>` — `todo.created`. */
    eventType: text('event_type').notNull(),
    /**
     * The event body, frozen at write time.
     *
     * `jsonb` rather than `json` so a payload can be queried and indexed while
     * debugging a stuck row; the key reordering that comes with it does not
     * matter because nothing compares payloads byte for byte.
     *
     * It is a snapshot on purpose. A relay that re-read the row at publish time
     * would emit the state at delivery rather than the state that was committed,
     * so a create followed by an update would publish the same body twice and
     * `todo.created` would describe a todo that never existed in that form.
     */
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    /** Delivery attempts started. Incremented by the claim, not by the result. */
    attempts: integer('attempts').notNull().default(0),
    /**
     * Not before this instant. It is both the retry schedule and the claim
     * lease: claiming pushes it out, so a relay that dies mid-publish releases
     * the row by expiry rather than by an `UPDATE` it never got to run.
     */
    availableAt: timestamp('available_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /** Set once the publisher accepted it. Null means still owed. */
    publishedAt: timestamp('published_at', { withTimezone: true }),
    /** Set when attempts ran out. A dead letter, kept for an operator to read. */
    failedAt: timestamp('failed_at', { withTimezone: true }),
    /** Why the last attempt failed, truncated. Cleared on success. */
    lastError: text('last_error'),
  },
  (table) => [
    // Partial, because the relay only ever asks for rows that are still owed.
    // Without the predicate the index would grow with every delivered row —
    // which, in a table that keeps its history, is all of them — and the planner
    // would walk that history on every poll. With it, the index holds the
    // backlog and an idle queue costs an empty scan.
    index('outbox_pending_idx')
      .on(table.availableAt, table.createdAt)
      .where(sql`${table.publishedAt} is null and ${table.failedAt} is null`),
  ],
)

export type OutboxRow = typeof outbox.$inferSelect
export type NewOutboxRow = typeof outbox.$inferInsert
