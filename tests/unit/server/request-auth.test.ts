import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

import {
  ANONYMOUS_AUTH,
  createRequestAuth,
  isAuthenticated,
  requireAuth,
  type RequestAuth,
} from '~/server/utils/request-auth'

/**
 * `createError` is a Nitro auto-import and is not defined in the node test
 * environment. The stub mirrors the shape h3 produces — an `Error` carrying
 * `statusCode`, `message` and `data` — because that shape is what the
 * assertions below are actually about; a `vi.fn()` returning `undefined` would
 * let `requireAuth` "throw" nothing and still pass.
 *
 * It is stubbed here rather than in tests/setup.ts because it is only called at
 * request time, not at module evaluation, so a per-file stub is late enough.
 */
class StubHttpError extends Error {
  statusCode: number
  data: unknown

  constructor(input: { statusCode: number; message: string; data?: unknown }) {
    super(input.message)
    this.statusCode = input.statusCode
    this.data = input.data
  }
}

beforeEach(() => {
  vi.stubGlobal('createError', (input: ConstructorParameters<typeof StubHttpError>[0]) => {
    return new StubHttpError(input)
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const alice = {
  id: 'user-1',
  email: 'alice@example.com',
  name: 'Alice Example',
  provider: 'credentials' as const,
}

// Derived from `requireAuth` rather than imported as `H3Event` from 'h3': the
// test project resolves `h3` only through a generated path mapping, and the two
// lines of a fake event are all `requireAuth` reads anyway.
type AuthEvent = Parameters<typeof requireAuth>[0]

function eventWith(auth: RequestAuth | undefined, path = '/api/posts'): AuthEvent {
  return { path, context: auth === undefined ? {} : { auth } } as unknown as AuthEvent
}

describe('createRequestAuth', () => {
  it('reports an authenticated request and keeps the session id', () => {
    const auth = createRequestAuth({ id: 'sess-1', user: alice })

    expect(auth.authenticated).toBe(true)
    expect(auth.user).toEqual(alice)
    expect(auth.sessionId).toBe('sess-1')
  })

  it('treats a session with no user as anonymous', () => {
    // h3 mints an empty session object for a request with no cookie, so the
    // presence of a session says nothing — the user is the discriminant.
    expect(createRequestAuth({ id: 'sess-1' })).toBe(ANONYMOUS_AUTH)
    expect(createRequestAuth({ id: 'sess-1', user: null })).toBe(ANONYMOUS_AUTH)
    expect(createRequestAuth({})).toBe(ANONYMOUS_AUTH)
    expect(createRequestAuth(null)).toBe(ANONYMOUS_AUTH)
    expect(createRequestAuth(undefined)).toBe(ANONYMOUS_AUTH)
  })

  it('returns the shared frozen anonymous value rather than a copy', () => {
    // Anonymous is the hot path (every unauthenticated probe); allocating a
    // fresh object per request would be silent waste, and freezing it means a
    // handler cannot mutate one request's view into another's.
    expect(createRequestAuth({})).toBe(createRequestAuth({}))
    expect(Object.isFrozen(ANONYMOUS_AUTH)).toBe(true)
  })

  it('falls back to a null session id when the session has none', () => {
    expect(createRequestAuth({ user: alice }).sessionId).toBeNull()
  })
})

describe('isAuthenticated', () => {
  it('narrows the union', () => {
    const auth = createRequestAuth({ user: alice })
    expect(isAuthenticated(auth)).toBe(true)
    if (isAuthenticated(auth)) {
      // The point of the guard: `user` is `User` here, not `User | null`, so it
      // is read with no `!` and no cast.
      expect(auth.user).toBe(alice)
    }
    expect(isAuthenticated(ANONYMOUS_AUTH)).toBe(false)
  })
})

describe('requireAuth', () => {
  it('returns the narrowed auth for an authenticated request', () => {
    const auth = createRequestAuth({ id: 'sess-1', user: alice })
    expect(requireAuth(eventWith(auth))).toBe(auth)
  })

  it('throws 401 when the request has no user', () => {
    expect(() => requireAuth(eventWith(ANONYMOUS_AUTH))).toThrowError(
      expect.objectContaining({ statusCode: 401 }),
    )
  })

  it('throws 500 naming the policy file when no middleware resolved a context', () => {
    // Not a 401: the caller cannot fix this by logging in. It means the handler
    // sits on a path the access policy calls `unmanaged`.
    let thrown: unknown
    try {
      requireAuth(eventWith(undefined, '/api/orphan'))
    } catch (error) {
      thrown = error
    }

    expect(thrown).toMatchObject({ statusCode: 500 })
    expect((thrown as Error).message).toContain('/api/orphan')
    expect((thrown as Error).message).toContain('server/utils/access-policy.ts')
  })
})
