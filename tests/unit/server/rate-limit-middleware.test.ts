import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createStorage } from 'unstorage'
import memoryDriver from 'unstorage/drivers/memory'
import type { Storage } from 'unstorage'

import rateLimitMiddleware from '~/server/middleware/30.rate-limit'
import {
  RATE_LIMIT_ERROR_CODE,
  RATE_LIMIT_LIMIT_HEADER,
  RATE_LIMIT_POLICY_HEADER,
  RATE_LIMIT_REMAINING_HEADER,
  RATE_LIMIT_RESET_HEADER,
  RETRY_AFTER_HEADER,
  type RateLimitRecord,
} from '~/server/utils/rate-limit'

/**
 * The rate-limit middleware, invoked directly with a fake event.
 *
 * `defineEventHandler` is stubbed to an identity wrapper in tests/setup.ts — it is
 * the one thing here that runs at module-evaluation time, so it has to be stubbed
 * before the static import above. Everything else the handler touches
 * (`useRuntimeConfig`, `getRequestHeader`, `setResponseHeader`, `useStorage`,
 * `createError`) is a Nitro auto-import called at *request* time, so a per-file
 * stub is early enough. Same arrangement, and the same reasoning, as
 * `tests/unit/server/csrf-middleware.test.ts`.
 *
 * What the decision *is* lives in `rate-limit.test.ts`, and which bucket it comes
 * out of in `rate-limit-policy.test.ts`. This file asserts only the
 * request-shaped half: which requests are counted, whose bucket they land in,
 * what a refusal looks like on the wire, and what happens when the store is down.
 */

interface FakeEvent {
  path: string
  method: string
  context: Record<string, unknown>
  requestHeaders: Record<string, string>
  responseHeaders: Record<string, string>
  node?: { req: { socket: { remoteAddress?: string } } }
}

function createEvent(overrides: Partial<FakeEvent> = {}): FakeEvent {
  return {
    path: '/api/todos',
    method: 'GET',
    context: { requestId: 'req-1' },
    requestHeaders: {},
    responseHeaders: {},
    node: { req: { socket: { remoteAddress: '203.0.113.7' } } },
    ...overrides,
  }
}

function run(event: FakeEvent): Promise<unknown> {
  return (rateLimitMiddleware as unknown as (event: FakeEvent) => Promise<unknown>)(event)
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

/** The rejection, or `null` when the middleware let the request through. */
async function refusalOf(event: FakeEvent): Promise<StubHttpError | null> {
  try {
    await run(event)
    return null
  } catch (error) {
    if (error instanceof StubHttpError) return error
    throw error
  }
}

/** Sends `count` requests through the middleware, returning each outcome. */
async function send(count: number, event: () => FakeEvent): Promise<(StubHttpError | null)[]> {
  const outcomes: (StubHttpError | null)[] = []
  for (let attempt = 0; attempt < count; attempt++) {
    outcomes.push(await refusalOf(event()))
  }
  return outcomes
}

let runtimeConfig: Record<string, unknown>
let limiter: Storage<RateLimitRecord>

beforeEach(() => {
  runtimeConfig = {}
  limiter = createStorage<RateLimitRecord>({ driver: memoryDriver() })

  vi.stubGlobal('useRuntimeConfig', () => runtimeConfig)
  vi.stubGlobal('useStorage', () => limiter)
  vi.stubGlobal(
    'getRequestHeader',
    (event: FakeEvent, name: string) => event.requestHeaders[name.toLowerCase()],
  )
  vi.stubGlobal('setResponseHeader', (event: FakeEvent, name: string, value: string) => {
    event.responseHeaders[name] = value
  })
  vi.stubGlobal(
    'createError',
    (input: { statusCode: number; message: string; data?: unknown }) => new StubHttpError(input),
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('which requests are counted', () => {
  it('leaves page and asset traffic alone, with no store access at all', async () => {
    const reads = vi.fn()
    vi.stubGlobal('useStorage', () => ({ getItem: reads, setItem: reads }))

    for (const path of ['/', '/login', '/_nuxt/entry.js']) {
      await expect(refusalOf(createEvent({ path }))).resolves.toBeNull()
    }

    // The cost claim in the middleware's own doc comment: not one round trip for
    // traffic the policy does not cover.
    expect(reads).not.toHaveBeenCalled()
  })

  it('counts an API request and reports the allowance on the response', async () => {
    const event = createEvent()

    await expect(refusalOf(event)).resolves.toBeNull()

    expect(event.responseHeaders[RATE_LIMIT_LIMIT_HEADER]).toBe('300')
    expect(event.responseHeaders[RATE_LIMIT_REMAINING_HEADER]).toBe('299')
    expect(event.responseHeaders[RATE_LIMIT_POLICY_HEADER]).toBe('300;w=60')
    expect(event.responseHeaders[RATE_LIMIT_RESET_HEADER]).toBeDefined()
    // Nothing to retry — the request was admitted.
    expect(event.responseHeaders[RETRY_AFTER_HEADER]).toBeUndefined()
  })

  it('does nothing at all when the limiter is switched off', async () => {
    runtimeConfig = { rateLimit: { enabled: false } }
    const event = createEvent()

    await expect(refusalOf(event)).resolves.toBeNull()

    expect(event.responseHeaders).toEqual({})
  })

  it('honours the string "false" an environment variable actually delivers', async () => {
    runtimeConfig = { rateLimit: { enabled: 'false' } }
    const event = createEvent()

    await refusalOf(event)

    expect(event.responseHeaders).toEqual({})
  })
})

describe('refusing an over-limit caller', () => {
  it('answers 429 with Retry-After once the login bucket is spent', async () => {
    const login = () => createEvent({ path: '/api/auth/login', method: 'POST' })

    const outcomes = await send(5, login)
    expect(outcomes.every((outcome) => outcome === null)).toBe(true)

    const event = login()
    const refusal = await refusalOf(event)

    expect(refusal?.statusCode).toBe(429)
    expect(refusal?.data).toMatchObject({
      code: RATE_LIMIT_ERROR_CODE,
      limit: 5,
      windowSeconds: 300,
      requestId: 'req-1',
    })
    // The headers go on the response before the throw, so a client learns when to
    // come back rather than only that it was refused.
    expect(event.responseHeaders[RETRY_AFTER_HEADER]).toBe('60')
    expect(event.responseHeaders[RATE_LIMIT_REMAINING_HEADER]).toBe('0')
  })

  it('names a retry delay in the message a developer will actually read', async () => {
    const login = () => createEvent({ path: '/api/auth/login', method: 'POST' })
    await send(5, login)

    const refusal = await refusalOf(login())

    expect(refusal?.message).toMatch(/5 requests per 300s/)
    expect(refusal?.message).toMatch(/Retry in 60s/)
  })

  it('applies the tight login limit rather than the API default', async () => {
    // The carve-out is the point of the table: six login attempts is a refusal
    // where six ordinary API calls are not.
    const outcomes = await send(6, () => createEvent({ path: '/api/auth/login', method: 'POST' }))
    const ordinary = await send(6, () => createEvent({ path: '/api/todos' }))

    expect(outcomes.filter((outcome) => outcome !== null)).toHaveLength(1)
    expect(ordinary.every((outcome) => outcome === null)).toBe(true)
  })
})

describe('whose bucket a request lands in', () => {
  it('keeps two addresses independent', async () => {
    const attempts = (address: string) => () =>
      createEvent({
        path: '/api/auth/login',
        method: 'POST',
        node: { req: { socket: { remoteAddress: address } } },
      })

    await send(5, attempts('203.0.113.7'))

    await expect(refusalOf(attempts('203.0.113.7')())).resolves.not.toBeNull()
    await expect(refusalOf(attempts('198.51.100.9')())).resolves.toBeNull()
  })

  it('counts a signed-in caller against their user id, not their address', async () => {
    // Same address, two users: the second must not inherit the first's spending.
    const authed = (userId: string, address: string) => () =>
      createEvent({
        path: '/api/cached/invalidate',
        method: 'POST',
        context: {
          requestId: 'req-1',
          auth: { authenticated: true, user: { id: userId }, sessionId: 'sess-1' },
        },
        node: { req: { socket: { remoteAddress: address } } },
      })

    // `/api/cached/invalidate` is 5 per minute.
    await send(5, authed('user-1', '203.0.113.7'))

    await expect(refusalOf(authed('user-1', '203.0.113.7')())).resolves.not.toBeNull()
    await expect(refusalOf(authed('user-2', '203.0.113.7')())).resolves.toBeNull()
  })

  it('ignores a spoofed x-forwarded-for when no proxy is trusted', async () => {
    // The default configuration. A caller varying the header must not get a fresh
    // bucket each time — this is the bypass the whole hop-count design exists for.
    const spoofing = (claimed: string) => () =>
      createEvent({
        path: '/api/auth/login',
        method: 'POST',
        requestHeaders: { 'x-forwarded-for': claimed },
      })

    const outcomes = await send(6, spoofing('9.9.9.9'))
    expect(outcomes.filter((outcome) => outcome !== null)).toHaveLength(1)

    // A different claimed address, same socket: still refused.
    await expect(refusalOf(spoofing('8.8.8.8')())).resolves.not.toBeNull()
  })

  it('reads the trusted hop when one proxy is configured', async () => {
    runtimeConfig = { rateLimit: { trustProxyHops: 1 } }

    const behindProxy = (chain: string) => () =>
      createEvent({
        path: '/api/auth/login',
        method: 'POST',
        requestHeaders: { 'x-forwarded-for': chain },
        node: { req: { socket: { remoteAddress: '10.0.0.1' } } },
      })

    // The balancer appends the real client; the client's own claim leads.
    await send(5, behindProxy('9.9.9.9, 203.0.113.7'))

    // Same real client, a different spoofed prefix — still their own bucket.
    await expect(refusalOf(behindProxy('1.1.1.1, 203.0.113.7')())).resolves.not.toBeNull()
    // A genuinely different client behind the same balancer is unaffected.
    await expect(refusalOf(behindProxy('9.9.9.9, 198.51.100.9')())).resolves.toBeNull()
  })

  it('separates buckets per rule, so one endpoint cannot exhaust another', async () => {
    await send(5, () => createEvent({ path: '/api/auth/login', method: 'POST' }))

    await expect(
      refusalOf(createEvent({ path: '/api/auth/login', method: 'POST' })),
    ).resolves.not.toBeNull()
    // `/api/auth/logout` resolves through `/api/auth/**`, a different rule.
    await expect(
      refusalOf(createEvent({ path: '/api/auth/logout', method: 'POST' })),
    ).resolves.toBeNull()
  })

  it('counts a normalised path, so a traversal cannot buy a fresh bucket', async () => {
    await send(5, () => createEvent({ path: '/api/auth/login', method: 'POST' }))

    for (const path of [
      '/api/auth/login',
      '/api/auth/login/',
      '//api//auth//login',
      '/api/auth/login?next=/',
      '/api/todos/%2e%2e/auth/login',
    ]) {
      await expect(refusalOf(createEvent({ path, method: 'POST' }))).resolves.not.toBeNull()
    }
  })
})

describe('when the store is unreachable', () => {
  it('admits the request and logs, rather than failing the app closed', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.stubGlobal('useStorage', () => ({
      getItem: () => Promise.reject(new Error('ECONNREFUSED')),
      setItem: () => Promise.resolve(),
    }))

    const event = createEvent()

    await expect(refusalOf(event)).resolves.toBeNull()
    expect(error).toHaveBeenCalledOnce()
    // No headers, because there is no allowance this request established — a
    // `RateLimit-Remaining` here would be a number the client could believe.
    expect(event.responseHeaders).toEqual({})
  })

  it('admits the request when the write fails after a successful read', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.stubGlobal('useStorage', () => ({
      getItem: () => Promise.resolve(null),
      setItem: () => Promise.reject(new Error('READONLY')),
    }))

    await expect(refusalOf(createEvent())).resolves.toBeNull()
    expect(error).toHaveBeenCalledOnce()
  })
})
