import { describe, expect, it } from 'vitest'

import type { Todo } from '~/server/db/schema'
import {
  TODO_AGGREGATE,
  TODO_CREATED,
  TODO_DELETED,
  TODO_UPDATED,
  todoCreatedMessage,
  todoDeletedMessage,
  todoUpdatedMessage,
} from '~/server/utils/todo-events'

const TODO: Todo = {
  id: '22222222-2222-4222-8222-222222222222',
  title: 'Write the relay',
  completed: false,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:05:00.000Z'),
  version: 3,
}

describe('todoCreatedMessage', () => {
  it('addresses the event to the row it describes', () => {
    const message = todoCreatedMessage(TODO)

    expect(message.aggregateType).toBe(TODO_AGGREGATE)
    expect(message.aggregateId).toBe(TODO.id)
    expect(message.eventType).toBe(TODO_CREATED)
  })

  it('carries the row as JSON, with dates as strings', () => {
    // The payload lands in a `jsonb` column, so a `Date` here would be a value
    // that no longer matches its own declared type once it is read back.
    expect(todoCreatedMessage(TODO).payload).toEqual({
      id: TODO.id,
      title: 'Write the relay',
      completed: false,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:05:00.000Z',
      version: 3,
    })
  })

  it('is serialisable without loss', () => {
    const payload = todoCreatedMessage(TODO).payload
    expect(JSON.parse(JSON.stringify(payload))).toEqual(payload)
  })
})

describe('todoUpdatedMessage', () => {
  it('carries the row as it is after the update, not a diff', () => {
    const updated = { ...TODO, completed: true }
    const message = todoUpdatedMessage(updated)

    expect(message.eventType).toBe(TODO_UPDATED)
    expect(message.payload).toMatchObject({ completed: true })
    // `version` is the row's clock: a consumer applying events out of order
    // compares it rather than trusting arrival order. `updated_at` cannot be
    // used that way — two writes can share a timestamp, and a clock can go
    // backwards — which is why both are on the payload and only one orders.
    expect(message.payload['version']).toBe(3)
    expect(message.payload['updatedAt']).toBe('2026-01-01T00:05:00.000Z')
  })
})

describe('todoDeletedMessage', () => {
  it('carries the id, when the deleting transaction ran, and at what version', () => {
    const message = todoDeletedMessage(TODO.id, new Date('2026-01-02T03:04:05.000Z'), 3)

    expect(message).toEqual({
      aggregateType: TODO_AGGREGATE,
      aggregateId: TODO.id,
      eventType: TODO_DELETED,
      // The version is what lets a consumer order the delete against the
      // updates it has seen. Without it, a `todo.deleted` and a `todo.updated`
      // arriving out of order leave it guessing — and the guess that
      // resurrects a deleted row is the one that looks fine in testing.
      payload: { id: TODO.id, deletedAt: '2026-01-02T03:04:05.000Z', version: 3 },
    })
  })
})

describe('event names', () => {
  it('are namespaced by the aggregate, so a consumer can route on a prefix', () => {
    for (const name of [TODO_CREATED, TODO_UPDATED, TODO_DELETED]) {
      expect(name.startsWith(`${TODO_AGGREGATE}.`)).toBe(true)
    }
  })
})
