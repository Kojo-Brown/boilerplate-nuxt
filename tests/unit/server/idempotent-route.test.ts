import type { H3Event } from 'h3'
import { createStorage, type Storage } from 'unstorage'
import memoryDriver from 'unstorage/drivers/memory'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

import {
  defineIdempotentHandler,
  useIdempotencyStore,
  type IdempotentHandlerOptions,
} from '~/server/utils/idempotent-route'
import {
  IDEMPOTENCY_KEY_HEADER,
  IDEMPOTENCY_REPLAY_HEADER,
  idempotencyStoreKey,
  type IdempotencyRecord,
} from '~/server/utils/idempotency'
import { IDEMPOTENCY_BASE } from '~/server/utils/storage'

/**
 * The wrapper, invoked directly.
 *
 * `defineEventHandler` is stubbed to an identity wrapper in tests/setup.ts,
 * because it runs at module-evaluation time and a per-file stub would be too
 * late for a static import. Everything else the wrapper touches
 * (`getRequestHeader`, `readRawBody`, `createError`, `setResponseStatus`,
 * `getResponseStatus`, `setResponseHeader`, `useStorage`, `useRuntimeConfig`) is
 * a Nitro auto-import called at *request* time, so a per-file stub is early
 * enough and each test gets to say what those calls should do.
 *
 * The store is a real in-memory `unstorage`, not a mock: the whole point of the
 * wrapper is what a second request sees after a first one wrote, and a stub
 * returning a canned record would only prove it reads something.
 */

const KEY = 'e0e6ac2c-2f4f-4d2c-9b0e-3f2d1c4b5a60'
const USER = 'user-1'

interface FakeEvent {
  method: string
  path: string
  context: Record<string, unknown>
  requestHeaders: Record<string, string>
  responseHeaders: Record<string, string | number>
  responseStatus: number
  body: string | undefined
}

function createEvent(overrides: Partial<FakeEvent> = {}): FakeEvent {
  return {
    method: 'POST',
    path: '/api/todos',
    context: {
      requestId: 'req-1',
      auth: { authenticated: true, user: { id: USER }, sessionId: 'sess-1' },
    },
    requestHeaders: { [IDEMPOTENCY_KEY_HEADER]: KEY },
    responseHeaders: {},
    responseStatus: 200,
    body: '{"title":"buy milk"}',
    ...overrides,
  }
}

/** Cast at the single boundary where a fake event meets a typed handler. */
function run<T>(handler: unknown, event: FakeEvent): Promise<T> {
  return (handler as (event: FakeEvent) => Promise<T>)(event)
}

/** The mirror of {@link run}: one cast where a fake-event handler goes in. */
function wrap<T>(
  handler: (event: FakeEvent) => Promise<T>,
  options?: IdempotentHandlerOptions,
): unknown {
  return defineIdempotentHandler(handler as unknown as (event: H3Event) => Promise<T>, options)
}

class StubHttpError extends Error {
  statusCode: number
  data: unknown

  constructor(input: { statusCode: number; message: string; data?: unknown }) {
    super(input.message)
    this.statusCode = input.statusCode
    this.data = input.data
  }
}

let store: Storage<IdempotencyRecord>
let storeFailsOn: 'none' | 'getItem' | 'setItem' = 'none'

beforeEach(() => {
  store = createStorage<IdempotencyRecord>({ driver: memoryDriver() })
  storeFailsOn = 'none'

  const guarded = {
    getItem: store.getItem.bind(store),
    setItem: store.setItem.bind(store),
  }

  store.getItem = (async (...args: Parameters<typeof guarded.getItem>) => {
    if (storeFailsOn === 'getItem') throw new Error('redis is down')
    return guarded.getItem(...args)
  }) as typeof store.getItem

  store.setItem = (async (...args: Parameters<typeof guarded.setItem>) => {
    if (storeFailsOn === 'setItem') throw new Error('redis is down')
    return guarded.setItem(...args)
  }) as typeof store.setItem

  // Re-stubbed per test because `afterEach` unstubs every global, including the
  // ones tests/setup.ts installed — and `defineIdempotentHandler` is called from
  // inside a test body, not at module-evaluation time, so here is early enough.
  vi.stubGlobal('defineEventHandler', <T>(fn: T): T => fn)
  vi.stubGlobal('useStorage', (base?: string) => {
    expect(base).toBe(IDEMPOTENCY_BASE)
    return store
  })
  vi.stubGlobal('useRuntimeConfig', () => ({}))
  vi.stubGlobal('createError', (input: ConstructorParameters<typeof StubHttpError>[0]) => {
    return new StubHttpError(input)
  })
  vi.stubGlobal('getRequestHeader', (event: FakeEvent, name: string) => event.requestHeaders[name])
  vi.stubGlobal('readRawBody', async (event: FakeEvent) =>
    event.body === undefined ? undefined : new TextEncoder().encode(event.body),
  )
  vi.stubGlobal('setResponseHeader', (event: FakeEvent, name: string, value: string | number) => {
    event.responseHeaders[name] = value
  })
  vi.stubGlobal('setResponseStatus', (event: FakeEvent, status: number) => {
    event.responseStatus = status
  })
  vi.stubGlobal('getResponseStatus', (event: FakeEvent) => event.responseStatus)

  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/** A handler that counts its calls and reports a 201, like `todos/index.post`. */
function countingHandler(value: unknown = { data: { id: 't1' } }) {
  const handler = vi.fn(async (event: FakeEvent) => {
    setResponseStatus(event as never, 201)
    return value
  })

  return handler
}

describe('useIdempotencyStore', () => {
  it('reads the idempotency base, not the cache', () => {
    // Sharing the cache base would mean a cache flush erasing the record of
    // which operations had already run. The `expect` inside the useStorage stub
    // is what actually enforces it; this exercises the call.
    expect(useIdempotencyStore()).toBe(store)
  })
})

describe('requests without the header', () => {
  it('runs the handler and never touches the store', async () => {
    const handler = countingHandler()
    const route = wrap(handler)
    const event = createEvent({ requestHeaders: {} })

    await run(route, event)

    expect(handler).toHaveBeenCalledTimes(1)
    expect(await store.getKeys()).toEqual([])
    expect(event.responseHeaders[IDEMPOTENCY_REPLAY_HEADER]).toBeUndefined()
  })

  it('is unaffected by a store outage, so the route stays up', async () => {
    storeFailsOn = 'getItem'
    const handler = countingHandler()

    await run(wrap(handler), createEvent({ requestHeaders: {} }))

    expect(handler).toHaveBeenCalledTimes(1)
  })
})

describe('key validation', () => {
  it.each([
    ['a key too short to be unique', 'abc'],
    ['a key with a CRLF', 'order\r\n1234'],
    ['a 129-character key', 'a'.repeat(129)],
  ])('rejects %s with 400 and does not run the handler', async (_label, key) => {
    const handler = countingHandler()
    const event = createEvent({ requestHeaders: { [IDEMPOTENCY_KEY_HEADER]: key } })

    await expect(run(wrap(handler), event)).rejects.toMatchObject({
      statusCode: 400,
    })
    expect(handler).not.toHaveBeenCalled()
  })
})

describe('the first request under a key', () => {
  it('runs the handler, marks the response fresh, and stores it', async () => {
    const handler = countingHandler()
    const event = createEvent()

    const result = await run(wrap(handler), event)

    expect(handler).toHaveBeenCalledTimes(1)
    expect(result).toEqual({ data: { id: 't1' } })
    expect(event.responseHeaders[IDEMPOTENCY_REPLAY_HEADER]).toBe('false')
    expect(await store.getItem(idempotencyStoreKey(USER, KEY))).toMatchObject({
      state: 'completed',
      response: { status: 201, body: '{"data":{"id":"t1"}}' },
    })
  })

  it('says "false" rather than nothing, so a client can tell the feature is on', async () => {
    // A header that only appears on replays makes "no header" ambiguous between
    // "freshly executed" and "this route does not do idempotency at all".
    const event = createEvent()

    await run(wrap(countingHandler()), event)

    expect(event.responseHeaders).toHaveProperty(IDEMPOTENCY_REPLAY_HEADER, 'false')
  })
})

describe('a retry under the same key', () => {
  it('replays the first response without running the handler again', async () => {
    const handler = countingHandler()
    const route = wrap(handler)

    await run(route, createEvent())
    const retry = createEvent()
    const result = await run(route, retry)

    expect(handler).toHaveBeenCalledTimes(1)
    expect(result).toEqual({ data: { id: 't1' } })
    expect(retry.responseStatus).toBe(201)
    expect(retry.responseHeaders[IDEMPOTENCY_REPLAY_HEADER]).toBe('true')
  })

  it('replays bytes identical to the first response', async () => {
    // The wrapper's one cast claims the replayed value is the JSON projection of
    // the handler's return type. This is the assertion behind that claim: a
    // `Date` comes back as the ISO string it was serialised to, and Nitro
    // re-serialises it to exactly what the first caller received.
    const created = new Date('2026-09-07T09:00:00.000Z')
    const route = wrap(countingHandler({ data: { id: 't1', createdAt: created } }))

    const first = await run(route, createEvent())
    const replayed = await run(route, createEvent())

    expect(JSON.stringify(replayed)).toBe(JSON.stringify(first))
  })

  it('replays a 204 with no body', async () => {
    const handler = vi.fn(async (event: FakeEvent) => {
      setResponseStatus(event as never, 204)
    })
    const route = wrap(handler)

    await run(route, createEvent({ method: 'DELETE', path: '/api/todos/1', body: undefined }))
    const retry = createEvent({ method: 'DELETE', path: '/api/todos/1', body: undefined })
    const result = await run(route, retry)

    expect(handler).toHaveBeenCalledTimes(1)
    expect(result).toBeUndefined()
    expect(retry.responseStatus).toBe(204)
  })

  it('refuses a key reused with a different payload, rather than lying', async () => {
    // The failure this prevents is silent at every layer: the client gets the
    // first request's response for the second request's payload, and the write
    // it thought it made never happened.
    const handler = countingHandler()
    const route = wrap(handler)

    await run(route, createEvent())

    await expect(run(route, createEvent({ body: '{"title":"buy bread"}' }))).rejects.toMatchObject({
      statusCode: 422,
    })
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('refuses a key reused on a different route', async () => {
    const route = wrap(countingHandler())

    await run(route, createEvent())

    await expect(
      run(route, createEvent({ method: 'PATCH', path: '/api/todos/1' })),
    ).rejects.toMatchObject({ statusCode: 422 })
  })
})

describe('a duplicate that arrives while the first is still running', () => {
  it('answers 409 with Retry-After instead of executing twice', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const handler = vi.fn(async (event: FakeEvent) => {
      await gate
      setResponseStatus(event as never, 201)
      return { data: { id: 't1' } }
    })
    const route = wrap(handler)

    const inFlight = run(route, createEvent())
    // Let the first request take its claim before the duplicate arrives.
    await vi.waitFor(async () => {
      expect(await store.getItem(idempotencyStoreKey(USER, KEY))).toMatchObject({
        state: 'in-flight',
      })
    })

    const duplicate = createEvent()
    await expect(run(route, duplicate)).rejects.toMatchObject({ statusCode: 409 })
    expect(duplicate.responseHeaders['retry-after']).toBe(1)

    release()
    await inFlight
    expect(handler).toHaveBeenCalledTimes(1)
  })
})

describe('outcomes that are not stored', () => {
  it('releases the claim when the handler throws, so a retry re-executes', async () => {
    const handler = vi
      .fn()
      .mockRejectedValueOnce(new StubHttpError({ statusCode: 400, message: 'Invalid title' }))
      .mockImplementationOnce(async (event: FakeEvent) => {
        setResponseStatus(event as never, 201)
        return { data: { id: 't1' } }
      })
    const route = wrap(handler)

    await expect(run(route, createEvent())).rejects.toMatchObject({ statusCode: 400 })
    expect(await store.getItem(idempotencyStoreKey(USER, KEY))).toBeNull()

    // The same key, now free, runs again rather than replaying the error.
    const result = await run(route, createEvent())

    expect(result).toEqual({ data: { id: 't1' } })
    expect(handler).toHaveBeenCalledTimes(2)
  })

  it('releases the claim on a non-2xx the handler returned normally', async () => {
    const handler = vi.fn(async (event: FakeEvent) => {
      setResponseStatus(event as never, 302)
      return { data: null }
    })

    await run(wrap(handler), createEvent())

    expect(await store.getItem(idempotencyStoreKey(USER, KEY))).toBeNull()
  })
})

describe('store failures', () => {
  it('fails the request closed when the claim cannot be taken', async () => {
    // Fail-open here would hand the client the duplicate it explicitly asked not
    // to have, and it would never know. See the note in idempotent-route.ts on
    // why this differs from the session registry's fail-open stance.
    storeFailsOn = 'getItem'
    const handler = countingHandler()
    const event = createEvent()

    await expect(run(wrap(handler), event)).rejects.toMatchObject({
      statusCode: 503,
    })
    expect(handler).not.toHaveBeenCalled()
    expect(event.responseHeaders['retry-after']).toBe(1)
  })

  it('does not mask the handler’s error when the claim cannot be released', async () => {
    // The caller is already getting the handler's error, and the claim times out
    // on its own. Failing here instead would replace a 400 the client can act on
    // with a 500 it cannot.
    const route = wrap(async () => {
      throw new StubHttpError({ statusCode: 400, message: 'Invalid title' })
    })
    store.removeItem = (async () => {
      throw new Error('redis is down')
    }) as typeof store.removeItem

    await expect(run(route, createEvent())).rejects.toMatchObject({ statusCode: 400 })
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('could not release the claim'),
      expect.any(Error),
    )
  })

  it('still returns the response when the record cannot be written', async () => {
    // The mutation already happened. Turning it into a 500 would tell the client
    // its write failed when it did not — the worse of the two wrong answers.
    const handler = countingHandler()
    const route = wrap(handler)
    const event = createEvent()

    // Let the claim succeed, then break the completion write.
    const original = store.setItem.bind(store)
    let writes = 0
    store.setItem = (async (...args: Parameters<typeof original>) => {
      writes += 1
      if (writes > 1) throw new Error('redis is down')
      return original(...args)
    }) as typeof store.setItem

    const result = await run(route, event)

    expect(result).toEqual({ data: { id: 't1' } })
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('will re-execute the handler'),
      expect.any(Error),
    )
  })
})

describe('scope', () => {
  it('keeps two callers using the same key independent', async () => {
    const handler = countingHandler()
    const route = wrap(handler)

    await run(route, createEvent())
    const other = createEvent()
    other.context['auth'] = {
      authenticated: true,
      user: { id: 'user-2' },
      sessionId: 'sess-2',
    }

    await run(route, other)

    expect(handler).toHaveBeenCalledTimes(2)
    expect(other.responseHeaders[IDEMPOTENCY_REPLAY_HEADER]).toBe('false')
  })

  it('refuses to run on a route with no auth context, naming the policy file', async () => {
    // Without a caller there is no scope, and a shared scope would let any
    // caller replay any other's response by guessing a key. `requireAuth`
    // already throws the 500 that names the two files that have to agree.
    const handler = countingHandler()
    const event = createEvent({ context: { requestId: 'req-1' } })

    await expect(run(wrap(handler), event)).rejects.toMatchObject({
      statusCode: 500,
    })
    expect(handler).not.toHaveBeenCalled()
  })

  it('honours an explicit scope override', async () => {
    const handler = countingHandler()
    const route = wrap(handler, { scope: () => 'tenant-9' })

    await run(route, createEvent())

    expect(await store.getItem(idempotencyStoreKey('tenant-9', KEY))).toMatchObject({
      state: 'completed',
    })
  })
})
