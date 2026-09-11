import { createApiClient } from './api'
import { defineInjection } from './injection'

import type { ApiResponse, PaginatedResponse } from '~/types/api'
import type {
  TodoConflict,
  TodoDraft,
  TodoGateway,
  TodoGatewayOperation,
  TodoItem,
} from '~/types/todos'

/**
 * The contract every todo consumer injects and every adapter satisfies.
 *
 * Declared once, next to the adapters, so a component never imports a concrete
 * implementation — importing one is what would put the transport back in the
 * dependency graph of everything that renders a todo.
 */
export const todoGatewayInjection = defineInjection<TodoGateway>('todos.gateway')

/**
 * The rejection a write gets when the stored todo has moved past the version it
 * was working from.
 *
 * An `Error` subclass rather than a returned union, because every other failure
 * on this port rejects and a caller that forgets to check a union renders an
 * error object as if it were a todo. What makes it worth distinguishing from a
 * plain rejection is that it is *not a failure to act on by retrying*: the
 * request was well-formed and the server was healthy. Somebody else wrote first,
 * and the only thing that can resolve it is a decision about whose change
 * survives — which is a question for the user, not for a retry loop.
 *
 * Every adapter throws this one type. The HTTP adapter maps a 412 onto it, the
 * in-memory adapter raises it from its own version check, and a consumer
 * therefore handles conflicts identically against a database and against a
 * fixture — see `docs/optimistic-concurrency.md`.
 */
export class TodoConflictError extends Error {
  /** What the caller tried to write, and what it collided with. */
  readonly conflict: TodoConflict

  constructor(conflict: TodoConflict, message?: string) {
    super(message ?? defaultConflictMessage(conflict))
    // Set explicitly: `Error` is a builtin, and a subclass of one gets the base
    // constructor's name unless it is assigned. Without it, an `error.name`
    // read anywhere — a log line, a toast, a test — says "Error".
    this.name = 'TodoConflictError'
    this.conflict = conflict
  }
}

function defaultConflictMessage(conflict: TodoConflict): string {
  return conflict.current === null
    ? `Todo "${conflict.id}" was deleted while you were editing it`
    : `Todo "${conflict.id}" changed while you were editing it: you have version ` +
        `${conflict.expectedVersion}, it is now at version ${conflict.current.version}`
}

/** Narrows an unknown rejection to a conflict, for a `catch` that has both. */
export function isTodoConflictError(error: unknown): error is TodoConflictError {
  return error instanceof TodoConflictError
}

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

  /**
   * The in-memory equivalent of `WHERE id = $1 AND version = $2`.
   *
   * Enforced here rather than assumed, because "the fake does not bother with
   * versions" is how a consumer ends up written against a gateway that never
   * rejects, and the conflict path first runs in production. The
   * single-threadedness of JavaScript means this store cannot *produce* a race
   * on its own — which is exactly why the conflict has to be reachable some
   * other way, and is what `createConflictingTodoGateway` is for.
   */
  function requireVersion(id: string, expectedVersion: number): number {
    const index = items.findIndex((item) => item.id === id)
    const current = index === -1 ? null : (items[index] ?? null)

    if (current === null || current.version !== expectedVersion) {
      throw new TodoConflictError({ id, expectedVersion, current })
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
        version: 1,
      }
      items = [...items, created]
      return { ...created }
    },

    setCompleted: async (
      id: string,
      completed: boolean,
      expectedVersion: number,
    ): Promise<TodoItem> => {
      const index = requireVersion(id, expectedVersion)
      // Non-null: `requireVersion` threw if the id was absent, but
      // `noUncheckedIndexedAccess` cannot see that.
      const previous = items[index]!
      // Bumped here, like the database bumps it, so a second write using the
      // version the caller started with is rejected rather than applied.
      const updated: TodoItem = { ...previous, completed, version: previous.version + 1 }
      items = items.map((item, position) => (position === index ? updated : item))
      return { ...updated }
    },

    remove: async (id: string, expectedVersion: number): Promise<void> => {
      const index = requireVersion(id, expectedVersion)
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
  version: number
}

/** The subset of `$fetch` this adapter uses, so a test can pass a function. */
export type TodoHttpClient = <T>(
  path: string,
  options?: {
    method?: string
    body?: unknown
    params?: Record<string, unknown>
    headers?: Record<string, string>
  },
) => Promise<T>

/**
 * The status a failed `If-Match` comes back as — see `[id].patch.ts` for why
 * 412 and not 409.
 */
const PRECONDITION_FAILED = 412

/** The status a write gets when the row is gone: deleted, or never there. */
const NOT_FOUND = 404

/**
 * What `ofetch` puts on a rejection, as much of it as this adapter reads.
 *
 * Structural rather than an `instanceof FetchError`: the type is not exported
 * in a form that survives the two copies of `ofetch` a Nuxt app can resolve, and
 * a test that hands this adapter a plain function should be able to reject with
 * an object rather than construct a library error.
 */
interface HttpRejection {
  readonly statusCode?: number
  readonly status?: number
  readonly data?: { readonly current?: TodoWire | null } | undefined
}

function asRejection(error: unknown): HttpRejection | null {
  return typeof error === 'object' && error !== null ? (error as HttpRejection) : null
}

/**
 * Turns a rejected conditional write into a {@link TodoConflictError}, or
 * re-throws.
 *
 * A 404 is folded into the same conflict as a 412, with `current: null`. From
 * the client's side the two are one situation — "the todo you are holding is not
 * there to write to" — and the difference between "deleted a second ago" and
 * "never existed" is not one the UI can act on differently. What it must not do
 * is present it as a transport error: the user edited something that is gone,
 * and a toast saying "404" tells them nothing about what to do next.
 */
function toConflict(error: unknown, id: string, expectedVersion: number): never {
  const rejection = asRejection(error)
  const status = rejection?.statusCode ?? rejection?.status

  if (status !== PRECONDITION_FAILED && status !== NOT_FOUND) {
    throw error
  }

  const current = rejection?.data?.current
  throw new TodoConflictError({
    id,
    expectedVersion,
    current: current == null ? null : toItem(current),
  })
}

/**
 * Formats a version as the entity tag the server compares against.
 *
 * The quotes are part of the value — an unquoted `4` is not a valid entity tag,
 * and `server/utils/optimistic-concurrency.ts` rejects it with a 400 rather than
 * guessing what was meant.
 */
function ifMatch(version: number): string {
  return `"${version}"`
}

/** Maps the wire shape onto the domain type. Shared by the adapter's reads. */
function toItem(row: TodoWire): TodoItem {
  return {
    id: row.id,
    title: row.title,
    completed: row.completed,
    createdAt: new Date(row.createdAt).toISOString(),
    version: row.version,
  }
}

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

    setCompleted: async (
      id: string,
      completed: boolean,
      expectedVersion: number,
    ): Promise<TodoItem> => {
      try {
        const response = await client<ApiResponse<TodoWire>>(`/todos/${id}`, {
          method: 'PATCH',
          body: { completed },
          headers: { 'if-match': ifMatch(expectedVersion) },
        })
        return toItem(response.data)
      } catch (error) {
        toConflict(error, id, expectedVersion)
      }
    },

    remove: async (id: string, expectedVersion: number): Promise<void> => {
      try {
        // The route answers 204, so whatever comes back is not a todo and is
        // not read. Typed `unknown` rather than `void`, which is not a value.
        await client<unknown>(`/todos/${id}`, {
          method: 'DELETE',
          headers: { 'if-match': ifMatch(expectedVersion) },
        })
      } catch (error) {
        toConflict(error, id, expectedVersion)
      }
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

    setCompleted: async (
      id: string,
      completed: boolean,
      expectedVersion: number,
    ): Promise<TodoItem> => {
      if (shouldFail('setCompleted')) throw new Error(message)
      return inner.setCompleted(id, completed, expectedVersion)
    },

    remove: async (id: string, expectedVersion: number): Promise<void> => {
      if (shouldFail('remove')) throw new Error(message)
      return inner.remove(id, expectedVersion)
    },
  }
}

/** What the competing writer does ahead of one call. */
export type CompetingWrite = 'edit' | 'delete' | 'none'

/** Options for {@link createConflictingTodoGateway}. */
export interface ConflictingTodoGatewayOptions {
  /**
   * What the competing writer does, per call, in order. The last entry repeats
   * once the list runs out — `['edit']` is "somebody gets there first, every
   * time", and `['edit', 'none']` is "the first attempt loses, the retry lands".
   *
   *  - `edit` — another client saves a change first, so the row moves to a newer
   *    version and there is something to merge against.
   *  - `delete` — another client removes it, so there is not.
   *  - `none` — nobody interferes and the call goes through.
   */
  readonly script?: readonly CompetingWrite[]
}

/**
 * Wraps a {@link TodoGateway} and puts a competing writer in front of its
 * writes.
 *
 * A decorator over the port, like {@link createFaultyTodoGateway}, and it exists
 * for the same reason: the conflict path is the one branch that cannot be
 * reached by using the app normally. A genuine conflict needs two clients
 * writing between one client's read and its write — impossible against the
 * in-memory adapter, which is single-threaded, and awkward against the HTTP one,
 * which wants a second session and precise timing.
 *
 * What it stages is the *timing*, and nothing else. The competing write is
 * really performed against the inner gateway, so the row really does move to a
 * new version, and the rejection the caller gets is the inner gateway's own —
 * raised by its own version check, carrying its own row. Nothing here fabricates
 * a conflict, which matters for more than tidiness: a made-up "current" version
 * that the store had never actually reached would let a resolution succeed in
 * the dialog and fail against the real adapter, and the gap would only show up
 * in production.
 *
 * The competing writer flips `completed`, because that is the only field the
 * port can change. A second client renaming the todo is the more vivid demo and
 * would need a `rename` on the port that nothing else asks for.
 */
export function createConflictingTodoGateway(
  inner: TodoGateway,
  options: ConflictingTodoGatewayOptions = {},
): TodoGateway {
  const { script = ['edit'] } = options
  let call = 0

  function nextAction(): CompetingWrite {
    const action = script[Math.min(call, script.length - 1)] ?? 'none'
    call += 1
    return action
  }

  /** Runs the other client's write, if the script says there is one. */
  async function stage(id: string): Promise<void> {
    const action = nextAction()
    if (action === 'none') return

    const existing = (await inner.list()).find((item) => item.id === id)
    // Nothing to race with. The caller's own call is about to fail on its own,
    // with the same "there is no such row" conflict it would have got anyway.
    if (existing === undefined) return

    if (action === 'delete') {
      await inner.remove(id, existing.version)
      return
    }

    await inner.setCompleted(id, !existing.completed, existing.version)
  }

  return {
    list: inner.list,
    create: inner.create,

    setCompleted: async (
      id: string,
      completed: boolean,
      expectedVersion: number,
    ): Promise<TodoItem> => {
      await stage(id)
      // Not wrapped in a conflict of our own making: the inner gateway is now
      // genuinely ahead of `expectedVersion`, so this rejects by itself.
      return inner.setCompleted(id, completed, expectedVersion)
    },

    remove: async (id: string, expectedVersion: number): Promise<void> => {
      await stage(id)
      return inner.remove(id, expectedVersion)
    },
  }
}
