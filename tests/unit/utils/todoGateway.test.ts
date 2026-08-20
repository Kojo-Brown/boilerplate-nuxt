import { describe, it, expect, vi } from 'vitest'

import {
  createFaultyTodoGateway,
  createHttpTodoGateway,
  createInMemoryTodoGateway,
} from '../../../utils/todoGateway'

import type { TodoHttpClient } from '../../../utils/todoGateway'
import type { TodoItem } from '~/types/todos'

const SEED: readonly TodoItem[] = [
  { id: 'seed-1', title: 'Write the port', completed: true, createdAt: '2026-01-01T09:00:00.000Z' },
  {
    id: 'seed-2',
    title: 'Write an adapter',
    completed: false,
    createdAt: '2026-01-01T09:05:00.000Z',
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

    const updated = await gateway.setCompleted('seed-2', true)

    expect(updated.completed).toBe(true)
    expect((await gateway.list())[1]?.completed).toBe(true)
  })

  it('removes a todo', async () => {
    const gateway = memoryGateway()

    await gateway.remove('seed-1')

    expect((await gateway.list()).map((item) => item.id)).toEqual(['seed-2'])
  })

  it('rejects on an unknown id rather than resolving with nothing', async () => {
    const gateway = memoryGateway()

    await expect(gateway.setCompleted('ghost', true)).rejects.toThrow('Todo "ghost" was not found')
    await expect(gateway.remove('ghost')).rejects.toThrow('Todo "ghost" was not found')
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
    const calls: { path: string; method: string; body?: unknown }[] = []

    const client = vi.fn(async (path: string, options?: { method?: string; body?: unknown }) => {
      calls.push({ path, method: options?.method ?? 'GET', body: options?.body })
      return responses[`${options?.method ?? 'GET'} ${path}`]
    }) as unknown as TodoHttpClient

    return { client, calls }
  }

  const wireTodo = {
    id: 'api-1',
    title: 'From the database',
    completed: false,
    // Sent as a serialized `Date`, which is what the Nitro route produces.
    createdAt: '2026-03-03T08:00:00.000Z',
    updatedAt: '2026-03-03T08:30:00.000Z',
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

    const updated = await createHttpTodoGateway({ client }).setCompleted('api-1', true)

    expect(updated.completed).toBe(true)
    expect(calls[0]).toEqual({ path: '/todos/api-1', method: 'PATCH', body: { completed: true } })
  })

  it('deletes without expecting a body, since the route answers 204', async () => {
    const { client, calls } = stubClient({ 'DELETE /todos/api-1': undefined })

    await expect(createHttpTodoGateway({ client }).remove('api-1')).resolves.toBeUndefined()
    expect(calls[0]).toEqual({ path: '/todos/api-1', method: 'DELETE', body: undefined })
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
    await expect(gateway.setCompleted('seed-1', false)).resolves.toMatchObject({ completed: false })
    await expect(gateway.remove('seed-1')).resolves.toBeUndefined()
  })

  it('fails every operation by default', async () => {
    const gateway = createFaultyTodoGateway(memoryGateway())

    await expect(gateway.list()).rejects.toThrow('The todo service is unavailable')
    await expect(gateway.create({ title: 'x' })).rejects.toThrow()
    await expect(gateway.setCompleted('seed-1', false)).rejects.toThrow()
    await expect(gateway.remove('seed-1')).rejects.toThrow()
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
