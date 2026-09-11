import { describe, it, expect, vi } from 'vitest'

import {
  createConflictingTodoGateway,
  createFaultyTodoGateway,
  createHttpTodoGateway,
  createInMemoryTodoGateway,
  isTodoConflictError,
  TodoConflictError,
} from '../../../utils/todoGateway'

import type { TodoHttpClient } from '../../../utils/todoGateway'
import type { TodoItem } from '~/types/todos'

const SEED: readonly TodoItem[] = [
  {
    id: 'seed-1',
    title: 'Write the port',
    completed: true,
    createdAt: '2026-01-01T09:00:00.000Z',
    version: 1,
  },
  {
    id: 'seed-2',
    title: 'Write an adapter',
    completed: false,
    createdAt: '2026-01-01T09:05:00.000Z',
    version: 2,
  },
]

/** Deterministic ids and clock, so assertions can name what they expect. */
function memoryGateway(seed: readonly TodoItem[] = SEED) {
  let issued = 0
  return createInMemoryTodoGateway({
    seed,
    nextId: () => `new-${(issued += 1)}`,
    now: () => new Date('2026-02-02T12:00:00.000Z'),
  })
}

describe('createInMemoryTodoGateway', () => {
  it('lists what it was seeded with', async () => {
    expect(await memoryGateway().list()).toEqual(SEED)
  })

  it('creates a todo with an issued id and the injected clock', async () => {
    const gateway = memoryGateway()

    const created = await gateway.create({ title: 'Ship it' })

    expect(created).toEqual({
      id: 'new-1',
      title: 'Ship it',
      completed: false,
      createdAt: '2026-02-02T12:00:00.000Z',
      // A created row starts at 1, the same place the column's default puts it.
      version: 1,
    })
    expect(await gateway.list()).toHaveLength(3)
  })

  it('trims the title and rejects a blank one, as the API route does', async () => {
    const gateway = memoryGateway()

    expect((await gateway.create({ title: '  padded  ' })).title).toBe('padded')
    await expect(gateway.create({ title: '   ' })).rejects.toThrow('Title is required')
    expect(await gateway.list()).toHaveLength(3)
  })

  it('toggles completion and returns the updated todo', async () => {
    const gateway = memoryGateway()

    const updated = await gateway.setCompleted('seed-2', true, 2)

    expect(updated.completed).toBe(true)
    expect((await gateway.list())[1]?.completed).toBe(true)
  })

  it('bumps the version on a write, like the database does', async () => {
    const gateway = memoryGateway()

    const updated = await gateway.setCompleted('seed-2', true, 2)

    expect(updated.version).toBe(3)
    expect((await gateway.list())[1]?.version).toBe(3)
  })

  it('rejects a second write that still holds the version it started with', async () => {
    // The in-memory store is single-threaded, so this is what a lost update
    // looks like when the two writes are merely *sequential* — and the guard
    // catches it just the same.
    const gateway = memoryGateway()
    await gateway.setCompleted('seed-2', true, 2)

    await expect(gateway.setCompleted('seed-2', false, 2)).rejects.toBeInstanceOf(TodoConflictError)
    expect((await gateway.list())[1]?.completed).toBe(true)
  })

  it('carries the stored row on the conflict, so the caller can show it', async () => {
    const gateway = memoryGateway()
    await gateway.setCompleted('seed-2', true, 2)

    const error = await gateway.setCompleted('seed-2', false, 2).catch((cause: unknown) => cause)

    expect(isTodoConflictError(error)).toBe(true)
    expect(isTodoConflictError(error) && error.conflict).toMatchObject({
      id: 'seed-2',
      expectedVersion: 2,
      current: { version: 3, completed: true },
    })
  })

  it('names itself, so a log line or a toast does not just say "Error"', async () => {
    const gateway = memoryGateway()

    const error = await gateway.setCompleted('ghost', true, 1).catch((cause: unknown) => cause)

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).name).toBe('TodoConflictError')
  })

  it('removes a todo', async () => {
    const gateway = memoryGateway()

    await gateway.remove('seed-1', 1)

    expect((await gateway.list()).map((item) => item.id)).toEqual(['seed-2'])
  })

  it('refuses a delete that holds a stale version', async () => {
    const gateway = memoryGateway()
    await gateway.setCompleted('seed-1', false, 1)

    await expect(gateway.remove('seed-1', 1)).rejects.toBeInstanceOf(TodoConflictError)
    expect(await gateway.list()).toHaveLength(2)
  })

  it('reports an unknown id as a conflict with nothing to merge against', async () => {
    // The same answer the HTTP adapter gives for a 404 on a conditional write:
    // from the caller's side, "deleted a second ago" and "never existed" are one
    // situation, and neither leaves anything to merge with.
    const gateway = memoryGateway()

    const error = await gateway.remove('ghost', 1).catch((cause: unknown) => cause)

    expect(isTodoConflictError(error)).toBe(true)
    expect(isTodoConflictError(error) && error.conflict.current).toBeNull()
  })

  it('does not alias the seed or the todos it hands out', async () => {
    // A consumer editing what it was given must not be able to edit the store,
    // because against the HTTP adapter that edit would go nowhere — a
    // difference in behaviour between adapters is a bug that only shows up in
    // production.
    const seed = [...SEED]
    const gateway = memoryGateway(seed)

    const listed = await gateway.list()
    listed[0]!.title = 'mutated'

    expect((await gateway.list())[0]?.title).toBe('Write the port')
    expect(seed).toEqual(SEED)
  })

  it('defaults to a real id source, a real clock, and an empty store', async () => {
    const gateway = createInMemoryTodoGateway()

    expect(await gateway.list()).toEqual([])

    const created = await gateway.create({ title: 'Default wiring' })

    expect(created.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(Number.isNaN(Date.parse(created.createdAt))).toBe(false)
    expect(created.version).toBe(1)
  })

  it('gives each instance its own store', async () => {
    const first = memoryGateway()
    const second = memoryGateway()

    await first.create({ title: 'only mine' })

    expect(await first.list()).toHaveLength(3)
    expect(await second.list()).toHaveLength(2)
  })
})

describe('createHttpTodoGateway', () => {
  /** Records calls and answers with whatever the test queued. */
  function stubClient(responses: Record<string, unknown>) {
    const calls: {
      path: string
      method: string
      body?: unknown
      // `| undefined` rather than optional: every call records the key, and a
      // `GET` records it as undefined. `exactOptionalPropertyTypes` keeps the
      // two spellings apart.
      headers?: Record<string, string> | undefined
    }[] = []

    const client = vi.fn(
      async (
        path: string,
        options?: { method?: string; body?: unknown; headers?: Record<string, string> },
      ) => {
        calls.push({
          path,
          method: options?.method ?? 'GET',
          body: options?.body,
          headers: options?.headers,
        })
        return responses[`${options?.method ?? 'GET'} ${path}`]
      },
    ) as unknown as TodoHttpClient

    return { client, calls }
  }

  /** A rejection shaped like the one `ofetch` throws for an error response. */
  function rejectWith(statusCode: number, data?: unknown) {
    return vi.fn(async () => {
      throw Object.assign(new Error(`HTTP ${statusCode}`), { statusCode, data })
    }) as unknown as TodoHttpClient
  }

  const wireTodo = {
    id: 'api-1',
    title: 'From the database',
    completed: false,
    // Sent as a serialized `Date`, which is what the Nitro route produces.
    createdAt: '2026-03-03T08:00:00.000Z',
    updatedAt: '2026-03-03T08:30:00.000Z',
    version: 4,
  }

  it('maps the paginated envelope onto the port, dropping the wire-only fields', async () => {
    const { client, calls } = stubClient({
      'GET /todos': { data: [wireTodo], pagination: {}, message: '', statusCode: 200 },
    })

    const items = await createHttpTodoGateway({ client }).list()

    expect(items).toEqual([
      {
        id: 'api-1',
        title: 'From the database',
        completed: false,
        createdAt: '2026-03-03T08:00:00.000Z',
        version: 4,
      },
    ])
    // `updatedAt` is not in the domain type — the adapter is where the wire
    // format stops.
    expect(items[0]).not.toHaveProperty('updatedAt')
    expect(calls[0]?.path).toBe('/todos')
  })

  it('asks for one page big enough to hold the list', async () => {
    const client = vi.fn(async () => ({
      data: [],
      pagination: {},
      message: '',
      statusCode: 200,
    })) as unknown as TodoHttpClient

    await createHttpTodoGateway({ client, pageSize: 25 }).list()

    expect(client).toHaveBeenCalledWith('/todos', { params: { page: 1, limit: 25 } })
  })

  it('posts a create and reads the todo back out of the envelope', async () => {
    const { client, calls } = stubClient({
      'POST /todos': { data: wireTodo, message: '', statusCode: 201 },
    })

    const created = await createHttpTodoGateway({ client }).create({ title: 'From the database' })

    expect(created.id).toBe('api-1')
    expect(calls[0]).toEqual({
      path: '/todos',
      method: 'POST',
      body: { title: 'From the database' },
    })
  })

  it('patches completion by id', async () => {
    const { client, calls } = stubClient({
      'PATCH /todos/api-1': {
        data: { ...wireTodo, completed: true },
        message: '',
        statusCode: 200,
      },
    })

    const updated = await createHttpTodoGateway({ client }).setCompleted('api-1', true, 4)

    expect(updated.completed).toBe(true)
    expect(calls[0]).toEqual({
      path: '/todos/api-1',
      method: 'PATCH',
      body: { completed: true },
      // Quoted: an unquoted `4` is not a valid entity tag and the route answers
      // 400 for it rather than guessing what was meant.
      headers: { 'if-match': '"4"' },
    })
  })

  it('deletes without expecting a body, since the route answers 204', async () => {
    const { client, calls } = stubClient({ 'DELETE /todos/api-1': undefined })

    await expect(createHttpTodoGateway({ client }).remove('api-1', 4)).resolves.toBeUndefined()
    expect(calls[0]).toEqual({
      path: '/todos/api-1',
      method: 'DELETE',
      body: undefined,
      headers: { 'if-match': '"4"' },
    })
  })

  it('turns a 412 into a conflict carrying the row the route sent back', async () => {
    const client = rejectWith(412, { current: { ...wireTodo, title: 'theirs', version: 5 } })

    const error = await createHttpTodoGateway({ client })
      .setCompleted('api-1', true, 4)
      .catch((cause: unknown) => cause)

    expect(isTodoConflictError(error)).toBe(true)
    expect(isTodoConflictError(error) && error.conflict).toEqual({
      id: 'api-1',
      expectedVersion: 4,
      current: {
        id: 'api-1',
        title: 'theirs',
        completed: false,
        createdAt: '2026-03-03T08:00:00.000Z',
        version: 5,
      },
    })
  })

  it('turns a 404 on a conditional write into a conflict with nothing to merge', async () => {
    const client = rejectWith(404, { current: null })

    const error = await createHttpTodoGateway({ client })
      .remove('api-1', 4)
      .catch((cause: unknown) => cause)

    expect(isTodoConflictError(error)).toBe(true)
    expect(isTodoConflictError(error) && error.conflict.current).toBeNull()
  })

  it('survives a 412 whose body the route did not fill in', async () => {
    // Defensive rather than hypothetical: a proxy or an error page can replace
    // the body, and a conflict that throws while being constructed would surface
    // as something entirely unrelated to what happened.
    const client = rejectWith(412)

    const error = await createHttpTodoGateway({ client })
      .setCompleted('api-1', true, 4)
      .catch((cause: unknown) => cause)

    expect(isTodoConflictError(error)).toBe(true)
    expect(isTodoConflictError(error) && error.conflict.current).toBeNull()
  })

  it('leaves every other status alone, so a 500 is not read as a conflict', async () => {
    const client = rejectWith(500, { message: 'boom' })

    await expect(createHttpTodoGateway({ client }).setCompleted('api-1', true, 4)).rejects.toThrow(
      'HTTP 500',
    )
  })

  it('re-throws a transport error, which carries no status at all', async () => {
    const client = vi.fn(async () => {
      throw new TypeError('Failed to fetch')
    }) as unknown as TodoHttpClient

    await expect(createHttpTodoGateway({ client }).remove('api-1', 4)).rejects.toThrow(
      'Failed to fetch',
    )
  })

  it('builds the app API client when no client is passed', async () => {
    // The default path, which production takes. `createApiClient()` reads
    // `$fetch`, so it must not run until the gateway is constructed — inside a
    // running Nuxt app rather than at module evaluation.
    const request = vi.fn(async () => ({ data: [], pagination: {}, message: '', statusCode: 200 }))
    const create = vi.fn(() => request)

    // Restored by hand rather than with `vi.unstubAllGlobals()`, which would
    // also drop the Nuxt auto-import stubs `tests/setup.ts` installs.
    const globals = globalThis as Record<string, unknown>
    const original = globals['$fetch']
    globals['$fetch'] = { create }

    try {
      const gateway = createHttpTodoGateway()
      expect(create).toHaveBeenCalledOnce()

      await gateway.list()
      expect(request).toHaveBeenCalledWith('/todos', { params: { page: 1, limit: 100 } })
    } finally {
      globals['$fetch'] = original
    }
  })

  it('lets a transport failure reach the caller', async () => {
    const client = vi.fn(async () => {
      throw new Error('fetch failed')
    }) as unknown as TodoHttpClient

    await expect(createHttpTodoGateway({ client }).list()).rejects.toThrow('fetch failed')
  })
})

describe('createFaultyTodoGateway', () => {
  it('fails only the operations it was told to, and passes the rest through', async () => {
    const gateway = createFaultyTodoGateway(memoryGateway(), {
      operations: ['create'],
      message: 'nope',
    })

    await expect(gateway.create({ title: 'x' })).rejects.toThrow('nope')
    await expect(gateway.list()).resolves.toHaveLength(2)
    await expect(gateway.setCompleted('seed-1', false, 1)).resolves.toMatchObject({
      completed: false,
    })
    await expect(gateway.remove('seed-1', 2)).resolves.toBeUndefined()
  })

  it('fails every operation by default', async () => {
    const gateway = createFaultyTodoGateway(memoryGateway())

    await expect(gateway.list()).rejects.toThrow('The todo service is unavailable')
    await expect(gateway.create({ title: 'x' })).rejects.toThrow()
    await expect(gateway.setCompleted('seed-1', false, 1)).rejects.toThrow()
    await expect(gateway.remove('seed-1', 1)).rejects.toThrow()
  })

  it('counts per operation, so every n-th call of each one fails', async () => {
    const inner = memoryGateway()
    const gateway = createFaultyTodoGateway(inner, { everyNthCall: 2, operations: ['create'] })

    await expect(gateway.create({ title: 'first' })).resolves.toMatchObject({ id: 'new-1' })
    await expect(gateway.create({ title: 'second' })).rejects.toThrow()
    await expect(gateway.create({ title: 'third' })).resolves.toMatchObject({ id: 'new-2' })

    // The rejected call never reached the inner gateway, so it consumed no id.
    expect((await inner.list()).map((item) => item.title)).toEqual([
      'Write the port',
      'Write an adapter',
      'first',
      'third',
    ])
  })

  it('stacks on anything satisfying the port, including itself', async () => {
    const gateway = createFaultyTodoGateway(
      createFaultyTodoGateway(memoryGateway(), { operations: ['create'], message: 'inner' }),
      { operations: ['list'], message: 'outer' },
    )

    await expect(gateway.list()).rejects.toThrow('outer')
    await expect(gateway.create({ title: 'x' })).rejects.toThrow('inner')
  })
})

describe('createConflictingTodoGateway', () => {
  it("rejects with the inner gateway's own conflict, not one of its making", async () => {
    // The whole value of staging only the timing is that everything downstream —
    // the composable, the dialog, every assertion about them — runs against the
    // genuine error, raised by the real version check.
    const gateway = createConflictingTodoGateway(memoryGateway())

    await expect(gateway.setCompleted('seed-1', false, 1)).rejects.toBeInstanceOf(TodoConflictError)
  })

  it('really performs the competing write, so the reported version is real', async () => {
    const inner = memoryGateway()
    const gateway = createConflictingTodoGateway(inner)

    const error = await gateway.setCompleted('seed-2', true, 2).catch((cause: unknown) => cause)

    expect(isTodoConflictError(error) && error.conflict).toMatchObject({
      id: 'seed-2',
      expectedVersion: 2,
      current: { version: 3, completed: true },
    })
    // The store agrees, which a fabricated conflict could not arrange: a
    // resolution that works in the dialog would otherwise fail against a real
    // adapter, and only in production.
    expect((await inner.list())[1]).toMatchObject({ version: 3, completed: true })
  })

  it('stages a deletion, which really removes the row', async () => {
    const inner = memoryGateway()
    const gateway = createConflictingTodoGateway(inner, { script: ['delete'] })

    const error = await gateway.remove('seed-1', 1).catch((cause: unknown) => cause)

    expect(isTodoConflictError(error) && error.conflict.current).toBeNull()
    expect((await inner.list()).map((item) => item.id)).toEqual(['seed-2'])
  })

  it('follows the script in order and repeats its last entry', async () => {
    const gateway = createConflictingTodoGateway(memoryGateway(), { script: ['edit', 'none'] })

    // 'edit' — somebody writes first and takes seed-1 to version 2.
    await expect(gateway.setCompleted('seed-1', false, 1)).rejects.toBeInstanceOf(TodoConflictError)
    // 'none' — nobody interferes, and the retry against version 2 lands.
    await expect(gateway.setCompleted('seed-1', false, 2)).resolves.toMatchObject({ version: 3 })
    // The list ran out, so 'none' keeps applying.
    await expect(gateway.setCompleted('seed-1', true, 3)).resolves.toMatchObject({ version: 4 })
  })

  it('leaves reads and creates untouched — a create has no version to lose', async () => {
    const gateway = createConflictingTodoGateway(memoryGateway())

    await expect(gateway.list()).resolves.toHaveLength(2)
    await expect(gateway.create({ title: 'x' })).resolves.toMatchObject({ version: 1 })
  })

  it('has nothing to race with on an unknown id, and says so the usual way', async () => {
    const gateway = createConflictingTodoGateway(memoryGateway())

    const error = await gateway.setCompleted('ghost', true, 1).catch((cause: unknown) => cause)

    expect(isTodoConflictError(error) && error.conflict.current).toBeNull()
  })
})
