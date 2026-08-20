import { createApiClient } from './api'
import { defineInjection } from './injection'

import type { ApiResponse, PaginatedResponse } from '~/types/api'
import type { TodoDraft, TodoGateway, TodoGatewayOperation, TodoItem } from '~/types/todos'

/**
 * The contract every todo consumer injects and every adapter satisfies.
 *
 * Declared once, next to the adapters, so a component never imports a concrete
 * implementation — importing one is what would put the transport back in the
 * dependency graph of everything that renders a todo.
 */
export const todoGatewayInjection = defineInjection<TodoGateway>('todos.gateway')

/** Options for {@link createInMemoryTodoGateway}. */
export interface InMemoryTodoGatewayOptions {
  /** Todos the gateway starts with. Copied, so the caller's array is untouched. */
  seed?: readonly TodoItem[]
  /** Id source for created todos. Defaults to `crypto.randomUUID()`. */
  nextId?: () => string
  /** Clock for `createdAt`. Defaults to the real one. */
  now?: () => Date
}

/**
 * An adapter that keeps todos in memory.
 *
 * Not a mock: it enforces the same rules the HTTP adapter does — a blank title
 * is rejected, an unknown id rejects rather than resolving with `undefined` —
 * so a consumer wired to it exercises the same paths. That is what makes it
 * usable for the demo page, for a Storybook-style preview, and for tests
 * alike, with no network and no database.
 *
 * Ids and the clock are injectable per the composable design rules, so a test
 * can assert on `'todo-1'` and a fixed timestamp instead of matching a UUID.
 *
 * State lives on the instance, so each call to this factory is an independent
 * store. Two provides mean two stores; providing it once at the top of a
 * subtree is what makes one store shared.
 */
export function createInMemoryTodoGateway(options: InMemoryTodoGatewayOptions = {}): TodoGateway {
  const { nextId = (): string => crypto.randomUUID(), now = (): Date => new Date() } = options

  let items: TodoItem[] = [...(options.seed ?? [])]

  function indexOf(id: string): number {
    const index = items.findIndex((item) => item.id === id)
    if (index === -1) {
      throw new Error(`Todo "${id}" was not found`)
    }
    return index
  }

  return {
    // Copies on the way out: a consumer that mutates what it was handed must
    // not be able to edit the store behind its own back, which is exactly the
    // bug an HTTP adapter cannot have and an in-memory one gets for free.
    list: async (): Promise<readonly TodoItem[]> => items.map((item) => ({ ...item })),

    create: async (draft: TodoDraft): Promise<TodoItem> => {
      const title = draft.title.trim()
      if (title.length === 0) {
        throw new Error('Title is required')
      }

      const created: TodoItem = {
        id: nextId(),
        title,
        completed: false,
        createdAt: now().toISOString(),
      }
      items = [...items, created]
      return { ...created }
    },

    setCompleted: async (id: string, completed: boolean): Promise<TodoItem> => {
      const index = indexOf(id)
      // Non-null: `indexOf` threw if the id was absent, but
      // `noUncheckedIndexedAccess` cannot see that.
      const updated: TodoItem = { ...items[index]!, completed }
      items = items.map((item, position) => (position === index ? updated : item))
      return { ...updated }
    },

    remove: async (id: string): Promise<void> => {
      const index = indexOf(id)
      items = items.filter((_, position) => position !== index)
    },
  }
}

/**
 * A todo as `/api/todos` sends it. Drizzle types `createdAt` as a `Date`
 * because that is what the driver hands back on the server; over the wire it is
 * whatever `JSON.stringify` made of it.
 */
interface TodoWire {
  id: string
  title: string
  completed: boolean
  createdAt: string
  updatedAt: string
}

/** The subset of `$fetch` this adapter uses, so a test can pass a function. */
export type TodoHttpClient = <T>(
  path: string,
  options?: { method?: string; body?: unknown; params?: Record<string, unknown> },
) => Promise<T>

/** Options for {@link createHttpTodoGateway}. */
export interface HttpTodoGatewayOptions {
  /** Transport. Defaults to the app's `/api` client from `utils/api.ts`. */
  client?: TodoHttpClient
  /** How many todos to request per page. The API caps this at 100. */
  pageSize?: number
}

/**
 * The production adapter, talking to the Nitro routes in `server/api/todos/`.
 *
 * It is also where the wire format stops. `updatedAt` is dropped because no
 * consumer asked for it, and `createdAt` is normalised to a string, so a change
 * to the database schema or the response envelope is a change to this file and
 * to nothing that renders.
 */
export function createHttpTodoGateway(options: HttpTodoGatewayOptions = {}): TodoGateway {
  const { pageSize = 100 } = options
  // `createApiClient()` is called lazily rather than at module scope: it reads
  // `$fetch`, which only exists once a Nuxt app is running.
  const client = options.client ?? (createApiClient() as unknown as TodoHttpClient)

  function toItem(row: TodoWire): TodoItem {
    return {
      id: row.id,
      title: row.title,
      completed: row.completed,
      createdAt: new Date(row.createdAt).toISOString(),
    }
  }

  return {
    list: async (): Promise<readonly TodoItem[]> => {
      const response = await client<PaginatedResponse<TodoWire>>('/todos', {
        params: { page: 1, limit: pageSize },
      })
      return response.data.map(toItem)
    },

    create: async (draft: TodoDraft): Promise<TodoItem> => {
      const response = await client<ApiResponse<TodoWire>>('/todos', {
        method: 'POST',
        body: { title: draft.title },
      })
      return toItem(response.data)
    },

    setCompleted: async (id: string, completed: boolean): Promise<TodoItem> => {
      const response = await client<ApiResponse<TodoWire>>(`/todos/${id}`, {
        method: 'PATCH',
        body: { completed },
      })
      return toItem(response.data)
    },

    remove: async (id: string): Promise<void> => {
      // The route answers 204, so whatever comes back is not a todo and is
      // not read. Typed `unknown` rather than `void`, which is not a value.
      await client<unknown>(`/todos/${id}`, { method: 'DELETE' })
    },
  }
}

/** Options for {@link createFaultyTodoGateway}. */
export interface FaultyTodoGatewayOptions {
  /** Operations that should reject. Defaults to all of them. */
  operations?: readonly TodoGatewayOperation[]
  /** Message the rejection carries. */
  message?: string
  /**
   * Fail only every n-th call, counted per operation. `1` (the default) fails
   * every call; `2` fails the second, fourth, and so on, which is the shape of
   * a flaky backend rather than a dead one.
   */
  everyNthCall?: number
}

/**
 * Wraps any {@link TodoGateway} and makes some of its operations reject.
 *
 * A decorator over the port, not a separate implementation: it is the same
 * interface in and out, which is what lets it stack on top of the in-memory
 * adapter for the demo page and on top of a fake in a test. Error handling in
 * the consumer becomes something you can look at on purpose, instead of
 * something that runs the first time production has a bad day.
 */
export function createFaultyTodoGateway(
  inner: TodoGateway,
  options: FaultyTodoGatewayOptions = {},
): TodoGateway {
  const {
    operations = ['list', 'create', 'setCompleted', 'remove'],
    message = 'The todo service is unavailable',
    everyNthCall = 1,
  } = options

  const failing = new Set<TodoGatewayOperation>(operations)
  const calls = new Map<TodoGatewayOperation, number>()

  function shouldFail(operation: TodoGatewayOperation): boolean {
    if (!failing.has(operation)) return false
    const count = (calls.get(operation) ?? 0) + 1
    calls.set(operation, count)
    return count % everyNthCall === 0
  }

  return {
    list: async (): Promise<readonly TodoItem[]> => {
      if (shouldFail('list')) throw new Error(message)
      return inner.list()
    },

    create: async (draft: TodoDraft): Promise<TodoItem> => {
      if (shouldFail('create')) throw new Error(message)
      return inner.create(draft)
    },

    setCompleted: async (id: string, completed: boolean): Promise<TodoItem> => {
      if (shouldFail('setCompleted')) throw new Error(message)
      return inner.setCompleted(id, completed)
    },

    remove: async (id: string): Promise<void> => {
      if (shouldFail('remove')) throw new Error(message)
      return inner.remove(id)
    },
  }
}
