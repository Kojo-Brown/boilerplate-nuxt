import { createStorage } from 'unstorage'
import memoryDriver from 'unstorage/drivers/memory'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

import requestContextMiddleware from '~/server/middleware/00.request-context'
import authMiddleware from '~/server/middleware/10.auth'
import { ANONYMOUS_AUTH } from '~/server/utils/request-auth'
import { recordSession, revokeSession, type SessionRecord } from '~/server/utils/session-store'

/**
 * The middleware handlers themselves, invoked directly.
 *
 * `defineEventHandler` is stubbed to an identity wrapper in tests/setup.ts —
 * it is the one thing here that runs at module-evaluation time, so it has to be
 * stubbed before the static import above, which is why it lives in the setup
 * file. Everything else these handlers touch (`getRequestHeader`,
 * `setResponseHeader`, `getUserSession`, `createError`) is a Nitro auto-import
 * called at *request* time, so a per-file stub is early enough and each test
 * gets to say what those calls should do.
 */

interface FakeEvent {
  path: string
  context: Record<string, unknown>
  requestHeaders: Record<string, string>
  responseHeaders: Record<string, string>
}

function createEvent(path: string, requestHeaders: Record<string, string> = {}): FakeEvent {
  return { path, context: {}, requestHeaders, responseHeaders: {} }
}

/** Cast at the single boundary where a fake event meets a typed handler. */
function run(handler: unknown, event: FakeEvent): unknown {
  return (handler as (event: FakeEvent) => unknown)(event)
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

/** Whatever the next `getUserSession()` call should resolve to. */
let session: { id?: string; user?: unknown } = {}
let sessionCalls = 0

/**
 * A real in-memory `unstorage` standing in for the `sessions` base, rather than
 * a mock. The middleware's revocation check is a `getItem` whose answer depends
 * on what `recordSession`/`revokeSession` actually wrote, so a stub returning a
 * canned record would only prove the middleware reads *something*.
 */
let sessionStore: ReturnType<typeof createStorage<SessionRecord>>

/** Set to make the `sessions` base throw, standing in for Redis being down. */
let storageFails = false

let cleared = 0

beforeEach(() => {
  session = {}
  sessionCalls = 0
  sessionStore = createStorage<SessionRecord>({ driver: memoryDriver() })
  storageFails = false
  cleared = 0

  vi.stubGlobal('getRequestHeader', (event: FakeEvent, name: string) => event.requestHeaders[name])
  vi.stubGlobal('setResponseHeader', (event: FakeEvent, name: string, value: string) => {
    event.responseHeaders[name] = value
  })
  vi.stubGlobal('getUserSession', async () => {
    sessionCalls++
    return session
  })
  vi.stubGlobal('useStorage', () => {
    if (storageFails) throw new Error('redis unreachable')
    return sessionStore
  })
  vi.stubGlobal('clearUserSession', async () => {
    cleared++
  })
  vi.stubGlobal(
    'createError',
    (input: ConstructorParameters<typeof StubHttpError>[0]) => new StubHttpError(input),
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
})

/** Registers a live session for `userId`, the way a sign-in would. */
async function issue(userId: string, sessionId: string): Promise<void> {
  await recordSession(sessionStore, {
    userId,
    sessionId,
    provider: 'credentials',
    maxAgeSeconds: 3600,
  })
}

describe('00.request-context', () => {
  it('mints a request id and echoes it on the response', () => {
    const event = createEvent('/api/todos')
    run(requestContextMiddleware, event)

    expect(event.context['requestId']).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    )
    expect(event.responseHeaders['x-request-id']).toBe(event.context['requestId'])
  })

  it('stamps the arrival time', () => {
    const before = Date.now()
    const event = createEvent('/api/todos')
    run(requestContextMiddleware, event)

    expect(event.context['requestReceivedAt']).toBeGreaterThanOrEqual(before)
    expect(event.context['requestReceivedAt']).toBeLessThanOrEqual(Date.now())
  })

  it('adopts a usable id from x-request-id', () => {
    const event = createEvent('/api/todos', { 'x-request-id': 'caller-supplied-id-1' })
    run(requestContextMiddleware, event)

    expect(event.context['requestId']).toBe('caller-supplied-id-1')
  })

  it('adopts the x-correlation-id that utils/api.ts already sends', () => {
    const event = createEvent('/api/todos', { 'x-correlation-id': 'browser-correlation-1' })
    run(requestContextMiddleware, event)

    expect(event.context['requestId']).toBe('browser-correlation-1')
  })

  it('prefers x-request-id when the caller sends both', () => {
    const event = createEvent('/api/todos', {
      'x-request-id': 'preferred-id-value',
      'x-correlation-id': 'ignored-id-value',
    })
    run(requestContextMiddleware, event)

    expect(event.context['requestId']).toBe('preferred-id-value')
  })

  it('refuses an unsafe supplied id and mints one instead', () => {
    // The failure this prevents: `x-request-id` echoed verbatim into a response
    // header, splitting it and adding a second header of the caller's choosing.
    const event = createEvent('/api/todos', {
      'x-request-id': 'injected\r\nSet-Cookie: nuxt-session=stolen',
    })
    run(requestContextMiddleware, event)

    expect(event.context['requestId']).not.toContain('Set-Cookie')
    expect(event.responseHeaders['x-request-id']).not.toContain('\r')
  })

  it('falls through to the next handler rather than answering the request', () => {
    expect(run(requestContextMiddleware, createEvent('/api/todos'))).toBeUndefined()
  })
})

describe('10.auth', () => {
  it('leaves page and asset requests alone without reading the session', async () => {
    // The cost this avoids: unsealing an encrypted cookie for every `.js` chunk.
    for (const path of ['/', '/login', '/_nuxt/entry.js']) {
      const event = createEvent(path)
      await run(authMiddleware, event)
      expect(event.context['auth']).toBeUndefined()
    }
    expect(sessionCalls).toBe(0)
  })

  it('resolves auth for a public API route without requiring a session', async () => {
    const event = createEvent('/api/route-rules/swr')
    await run(authMiddleware, event)

    expect(sessionCalls).toBe(1)
    expect(event.context['auth']).toBe(ANONYMOUS_AUTH)
  })

  it('personalises a public route when the caller does have a session', async () => {
    session = { id: 'sess-1', user: { id: 'user-1', email: 'alice@example.com' } }
    const event = createEvent('/api/auth/login')
    await run(authMiddleware, event)

    expect(event.context['auth']).toMatchObject({ authenticated: true, sessionId: 'sess-1' })
  })

  it('rejects an anonymous request to a protected route with 401', async () => {
    const event = createEvent('/api/todos')
    event.context['requestId'] = 'req-under-test-1'

    await expect(run(authMiddleware, event)).rejects.toMatchObject({
      statusCode: 401,
      data: { requestId: 'req-under-test-1' },
    })
  })

  it('lets an authenticated request through with a narrowed context', async () => {
    session = { id: 'sess-1', user: { id: 'user-1', email: 'alice@example.com' } }
    const event = createEvent('/api/todos/11111111-2222-3333-4444-555555555555')

    await expect(run(authMiddleware, event)).resolves.toBeUndefined()
    expect(event.context['auth']).toMatchObject({
      authenticated: true,
      user: { id: 'user-1' },
      sessionId: 'sess-1',
    })
  })

  it('ignores the query string when matching the policy', async () => {
    const event = createEvent('/api/todos?page=2&limit=10')
    await expect(run(authMiddleware, event)).rejects.toMatchObject({ statusCode: 401 })
  })

  // The reason `normalisePathname` exists. Each of these reads as a path under
  // the public `/api/route-rules` prefix and resolves into protected `/api/todos`.
  it.each([
    ['a dot-segment traversal', '/api/route-rules/../todos'],
    ['an encoded traversal', '/api/route-rules/%2e%2e/todos'],
    ['a double-encoded traversal', '/api/route-rules/%252e%252e/todos'],
    ['a trailing slash', '/api/todos/'],
    ['a doubled slash', '//api//todos'],
  ])('does not let %s reach a protected route anonymously', async (_label, path) => {
    await expect(run(authMiddleware, createEvent(path))).rejects.toMatchObject({ statusCode: 401 })
  })

  it('reads the session exactly once per request', async () => {
    session = { id: 'sess-1', user: { id: 'user-1' } }
    await run(authMiddleware, createEvent('/api/todos'))

    expect(sessionCalls).toBe(1)
  })
})

describe('10.auth session revocation', () => {
  it('rejects a cryptographically valid cookie whose session was revoked', async () => {
    // The point of the whole registry: the cookie still unseals, `getUserSession`
    // still returns a user, and the request is still refused.
    await issue('user-1', 'sess-1')
    await revokeSession(sessionStore, 'user-1', 'sess-1')

    session = { id: 'sess-1', user: { id: 'user-1' } }
    const event = createEvent('/api/todos')
    event.context['requestId'] = 'req-revoked-1'

    await expect(run(authMiddleware, event)).rejects.toMatchObject({
      statusCode: 401,
      message: 'Session revoked',
      data: { requestId: 'req-revoked-1' },
    })
  })

  it('clears the cookie on rejection so the browser stops resending it', async () => {
    await issue('user-1', 'sess-1')
    await revokeSession(sessionStore, 'user-1', 'sess-1')
    session = { id: 'sess-1', user: { id: 'user-1' } }

    await expect(run(authMiddleware, createEvent('/api/todos'))).rejects.toThrow()
    expect(cleared).toBe(1)
  })

  it('lets a registered, un-revoked session through', async () => {
    await issue('user-1', 'sess-1')
    session = { id: 'sess-1', user: { id: 'user-1' } }

    await expect(run(authMiddleware, createEvent('/api/todos'))).resolves.toBeUndefined()
    expect(cleared).toBe(0)
  })

  it('lets an unregistered session through — missing means unknown, not denied', async () => {
    // Sessions issued before the registry existed, or while NUXT_REDIS_URL was
    // unset, have no record. Fail-open is the documented trade.
    session = { id: 'sess-never-registered', user: { id: 'user-1' } }

    await expect(run(authMiddleware, createEvent('/api/todos'))).resolves.toBeUndefined()
  })

  it('does not confuse two users who share a session id', async () => {
    await issue('user-1', 'shared-id')
    await issue('user-2', 'shared-id')
    await revokeSession(sessionStore, 'user-1', 'shared-id')

    session = { id: 'shared-id', user: { id: 'user-2' } }
    await expect(run(authMiddleware, createEvent('/api/todos'))).resolves.toBeUndefined()

    session = { id: 'shared-id', user: { id: 'user-1' } }
    await expect(run(authMiddleware, createEvent('/api/todos'))).rejects.toMatchObject({
      statusCode: 401,
    })
  })

  it('revokes on a public route too, so a revoked caller is not personalised', async () => {
    await issue('user-1', 'sess-1')
    await revokeSession(sessionStore, 'user-1', 'sess-1')
    session = { id: 'sess-1', user: { id: 'user-1' } }

    await expect(run(authMiddleware, createEvent('/api/route-rules/swr'))).rejects.toMatchObject({
      statusCode: 401,
    })
  })

  it('serves the request when the store is unreachable rather than signing everyone out', async () => {
    await issue('user-1', 'sess-1')
    session = { id: 'sess-1', user: { id: 'user-1' } }
    storageFails = true

    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(run(authMiddleware, createEvent('/api/todos'))).resolves.toBeUndefined()
    expect(errors).toHaveBeenCalledOnce()
    errors.mockRestore()
  })

  it('does not touch the store for an anonymous caller', async () => {
    // The read is per *authenticated* request. A logged-out visitor to a public
    // route must not cost a Redis round trip.
    storageFails = true
    const event = createEvent('/api/route-rules/swr')

    await expect(run(authMiddleware, event)).resolves.toBeUndefined()
    expect(event.context['auth']).toBe(ANONYMOUS_AUTH)
  })

  it('does not touch the store for an unmanaged path', async () => {
    storageFails = true
    session = { id: 'sess-1', user: { id: 'user-1' } }

    await expect(run(authMiddleware, createEvent('/_nuxt/entry.js'))).resolves.toBeUndefined()
  })

  it('skips the lookup for a session with no id', async () => {
    // h3 mints the id inside `setUserSession`; a session predating that has none
    // and there is nothing to look up.
    storageFails = true
    session = { user: { id: 'user-1' } }

    await expect(run(authMiddleware, createEvent('/api/todos'))).resolves.toBeUndefined()
  })
})
