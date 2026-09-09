import type { Todo } from '~/server/db/schema'
import type { OutboxMessage } from '~/server/utils/outbox'

/**
 * The events the todo routes emit, and the payload each carries.
 *
 * Builders rather than object literals inline in the handlers, for two reasons
 * that only show up later:
 *
 *  - **The payload is a contract.** Once a consumer reads
 *    `payload.completed`, changing it is a breaking change, and a shape assembled
 *    at three call sites drifts at two of them. Here it is one function per
 *    event with a test that pins the keys.
 *  - **Dates have to be strings.** The row goes to `jsonb`, so a `Date` would be
 *    serialised on the way in and read back as a string — meaning the type says
 *    `Date` and the value is not one, for every consumer and for the relay's own
 *    replay. Serialising deliberately keeps the declared shape true.
 */

/** The `aggregate_type` every todo event carries. */
export const TODO_AGGREGATE = 'todo'

export const TODO_CREATED = 'todo.created'
export const TODO_UPDATED = 'todo.updated'
export const TODO_DELETED = 'todo.deleted'

/** The body of `todo.created` and `todo.updated` — the row as JSON. */
export interface TodoEventPayload extends Record<string, unknown> {
  readonly id: string
  readonly title: string
  readonly completed: boolean
  readonly createdAt: string
  /**
   * The row's own version clock. A consumer applying events out of order — see
   * the ordering note in `server/utils/outbox.ts` — compares this rather than
   * arrival order, which is why it is on the payload and not only in the header.
   */
  readonly updatedAt: string
}

/** The body of `todo.deleted`. There is no row left to describe. */
export interface TodoDeletedPayload extends Record<string, unknown> {
  readonly id: string
  readonly deletedAt: string
}

function todoPayload(todo: Todo): TodoEventPayload {
  return {
    id: todo.id,
    title: todo.title,
    completed: todo.completed,
    createdAt: todo.createdAt.toISOString(),
    updatedAt: todo.updatedAt.toISOString(),
  }
}

/** `todo.created` — emitted in the transaction that inserted the row. */
export function todoCreatedMessage(todo: Todo): OutboxMessage {
  return {
    aggregateType: TODO_AGGREGATE,
    aggregateId: todo.id,
    eventType: TODO_CREATED,
    payload: todoPayload(todo),
  }
}

/** `todo.updated` — carries the row as it is after the update, not a diff. */
export function todoUpdatedMessage(todo: Todo): OutboxMessage {
  return {
    aggregateType: TODO_AGGREGATE,
    aggregateId: todo.id,
    eventType: TODO_UPDATED,
    payload: todoPayload(todo),
  }
}

/** `todo.deleted` — the id, and when the deleting transaction ran. */
export function todoDeletedMessage(id: string, deletedAt: Date): OutboxMessage {
  return {
    aggregateType: TODO_AGGREGATE,
    aggregateId: id,
    eventType: TODO_DELETED,
    payload: { id, deletedAt: deletedAt.toISOString() } satisfies TodoDeletedPayload,
  }
}
