import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

import csrfEndpoint from '~/server/api/auth/csrf.get'
import { inspectCsrfToken, mintCsrfToken } from '~/server/utils/csrf'
import { deriveCsrfKey, resetCsrfConfigCache } from '~/server/utils/csrf-config'
import { CSRF_COOKIE_NAME, CSRF_HEADER_NAME } from '~/types/csrf'

/**
 * `GET /api/auth/csrf`, invoked directly with a fake event.
 *
 * The route exists for the callers `server/middleware/20.csrf.ts` deliberately
 * does not issue to — a visitor whose first page was cached, a tab that has
 * outlived its token, a non-browser consumer — so what matters about it is that
 * what it hands back is usable, that it does not churn a good token, and that it
 * can never be cached.
 */

/** Obviously fake, and 40 characters: the derivation refuses anything under 32. */
const SECRET = 'test-only-session-password-not-a-secret!!'
const key = await deriveCsrfKey(SECRET)

interface FakeEvent {
  path: string
  context: Record<string, unknown>
  requestHeaders: Record<string, string>
  cookies: Record<string, string>
  setCookies: Record<string, { value: string; options: Record<string, unknown> }>
  responseHeaders: Record<string, string>
  node?: { req: { socket: object } }
}

function createEvent(cookies: Record<string, string> = {}): FakeEvent {
  return {
    path: '/api/auth/csrf',
    context: { requestId: 'req-1' },
    requestHeaders: { host: 'app.test' },
    cookies,
    setCookies: {},
    responseHeaders: {},
    node: { req: { socket: {} } },
  }
}

interface EndpointResult {
  token: string
  expiresIn: number
  header: string
}

function run(event: FakeEvent): Promise<EndpointResult> {
  return (csrfEndpoint as unknown as (event: FakeEvent) => Promise<EndpointResult>)(event)
}

class StubHttpError extends Error {
  statusCode: number
  constructor(input: { statusCode: number; message: string }) {
    super(input.message)
    this.statusCode = input.statusCode
  }
}

let runtimeConfig: Record<string, unknown>

beforeEach(() => {
  resetCsrfConfigCache()
  runtimeConfig = { session: { password: SECRET } }

  vi.stubGlobal('useRuntimeConfig', () => runtimeConfig)
  vi.stubGlobal(
    'getRequestHeader',
    (event: FakeEvent, name: string) => event.requestHeaders[name.toLowerCase()],
  )
  vi.stubGlobal('setResponseHeader', (event: FakeEvent, name: string, value: string) => {
    event.responseHeaders[name] = value
  })
  vi.stubGlobal('getCookie', (event: FakeEvent, name: string) => event.cookies[name])
  vi.stubGlobal(
    'setCookie',
    (event: FakeEvent, name: string, value: string, options: Record<string, unknown>) => {
      event.setCookies[name] = { value, options }
    },
  )
  vi.stubGlobal(
    'createError',
    (input: { statusCode: number; message: string }) => new StubHttpError(input),
  )
})

afterEach(() => {
  resetCsrfConfigCache()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('GET /api/auth/csrf', () => {
  it('hands back a token that verifies, and sets the same value as a cookie', async () => {
    const event = createEvent()

    const result = await run(event)

    expect(event.setCookies[CSRF_COOKIE_NAME]?.value).toBe(result.token)
    await expect(inspectCsrfToken(result.token, { key })).resolves.toMatchObject({
      status: 'valid',
    })
  })

  it('names the header to send it in, so a consumer hard-codes nothing', async () => {
    const result = await run(createEvent())

    expect(result.header).toBe(CSRF_HEADER_NAME)
    expect(result.expiresIn).toBeGreaterThan(0)
  })

  it('returns the existing token rather than churning the cookie', async () => {
    const existing = await mintCsrfToken({ key })
    const event = createEvent({ [CSRF_COOKIE_NAME]: existing })

    const result = await run(event)

    expect(result.token).toBe(existing)
    expect(event.setCookies).toEqual({})
  })

  it('replaces a token that no longer verifies', async () => {
    const event = createEvent({ [CSRF_COOKIE_NAME]: 'not.a.token' })

    const result = await run(event)

    expect(result.token).not.toBe('not.a.token')
    expect(event.setCookies[CSRF_COOKIE_NAME]?.value).toBe(result.token)
  })

  it('is never cached: the body is per-caller and the response sets a cookie', async () => {
    const event = createEvent()

    await run(event)

    expect(event.responseHeaders['cache-control']).toBe('no-store')
  })

  it('answers 503 on a server with no seal key, rather than an unsigned token', async () => {
    runtimeConfig = {}
    vi.spyOn(console, 'error').mockImplementation(() => {})

    await expect(run(createEvent())).rejects.toMatchObject({ statusCode: 503 })
  })
})
