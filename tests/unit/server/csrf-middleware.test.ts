import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

import csrfMiddleware from '~/server/middleware/20.csrf'
import { inspectCsrfToken, mintCsrfToken } from '~/server/utils/csrf'
import { deriveCsrfKey, resetCsrfConfigCache } from '~/server/utils/csrf-config'
import {
  CSRF_COOKIE_NAME,
  CSRF_COOKIE_SECURE_NAME,
  CSRF_ERROR_CODE,
  CSRF_HEADER_NAME,
} from '~/types/csrf'

/**
 * The CSRF middleware, invoked directly with a fake event.
 *
 * `defineEventHandler` is stubbed to an identity wrapper in tests/setup.ts — it
 * is the one thing here that runs at module-evaluation time, so it has to be
 * stubbed before the static import above. Everything else the handler touches
 * (`getRequestHeader`, `getCookie`, `setCookie`, `useRuntimeConfig`,
 * `createError`) is a Nitro auto-import called at *request* time, so a per-file
 * stub is early enough.
 *
 * What the decision *is* lives in `tests/unit/server/csrf.test.ts`. This file
 * asserts only the request-shaped half: which requests are checked, which get a
 * cookie, what the cookie's attributes are, and what a refusal looks like.
 */

/** Obviously fake, and 40 characters: the derivation refuses anything under 32. */
const SECRET = 'test-only-session-password-not-a-secret!!'
const OTHER_SECRET = 'a-different-test-only-password-32-chars++'
const key = await deriveCsrfKey(SECRET)

interface FakeCookie {
  value: string
  options: Record<string, unknown>
}

interface FakeEvent {
  path: string
  method: string
  context: Record<string, unknown>
  requestHeaders: Record<string, string>
  cookies: Record<string, string>
  setCookies: Record<string, FakeCookie>
  responseHeaders: Record<string, string>
  node?: { req: { socket: object } }
}

function createEvent(
  overrides: Partial<Pick<FakeEvent, 'path' | 'method' | 'requestHeaders' | 'cookies'>> = {},
  socket: object = {},
): FakeEvent {
  return {
    path: '/api/todos',
    method: 'POST',
    context: { requestId: 'req-1' },
    requestHeaders: { host: 'app.test', origin: 'https://app.test' },
    cookies: {},
    setCookies: {},
    responseHeaders: {},
    node: { req: { socket } },
    ...overrides,
  }
}

/** Cast at the single boundary where a fake event meets a typed handler. */
function run(event: FakeEvent): Promise<unknown> {
  return (csrfMiddleware as unknown as (event: FakeEvent) => Promise<unknown>)(event)
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
      event.cookies[name] = value
    },
  )
  vi.stubGlobal('createError', (input: { statusCode: number; message: string; data?: unknown }) => {
    return new StubHttpError(input)
  })
})

afterEach(() => {
  resetCsrfConfigCache()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/** A cookie/header pair the middleware will accept. */
async function validPair(): Promise<{ cookies: Record<string, string>; header: string }> {
  const token = await mintCsrfToken({ key })
  return { cookies: { [CSRF_COOKIE_NAME]: token }, header: token }
}

describe('state-changing requests', () => {
  it('lets through a same-origin write whose header matches its cookie', async () => {
    const { cookies, header } = await validPair()
    const event = createEvent({
      cookies,
      requestHeaders: {
        host: 'app.test',
        origin: 'https://app.test',
        [CSRF_HEADER_NAME]: header,
      },
    })

    await expect(refusalOf(event)).resolves.toBeNull()
  })

  it('refuses a cross-origin write with 403 and a machine-readable reason', async () => {
    const { cookies, header } = await validPair()
    const event = createEvent({
      cookies,
      requestHeaders: {
        host: 'app.test',
        origin: 'https://evil.test',
        [CSRF_HEADER_NAME]: header,
      },
    })

    const refusal = await refusalOf(event)

    expect(refusal?.statusCode).toBe(403)
    expect(refusal?.data).toMatchObject({
      code: CSRF_ERROR_CODE,
      reason: 'cross-origin',
      requestId: 'req-1',
    })
  })

  it('refuses a same-site sibling, which SameSite=Lax would have let through', async () => {
    const { cookies, header } = await validPair()
    const event = createEvent({
      cookies,
      requestHeaders: {
        host: 'app.test',
        origin: 'https://cdn.app.test',
        'sec-fetch-site': 'same-site',
        [CSRF_HEADER_NAME]: header,
      },
    })

    expect((await refusalOf(event))?.data).toMatchObject({ reason: 'cross-origin' })
  })

  it('accepts that sibling once an operator lists it', async () => {
    runtimeConfig = {
      session: { password: SECRET },
      security: { csrf: { allowedOrigins: 'https://cdn.app.test' } },
    }

    const { cookies, header } = await validPair()
    const event = createEvent({
      cookies,
      requestHeaders: {
        host: 'app.test',
        origin: 'https://cdn.app.test',
        'sec-fetch-site': 'same-site',
        [CSRF_HEADER_NAME]: header,
      },
    })

    await expect(refusalOf(event)).resolves.toBeNull()
  })

  it('refuses a write that carries no origin signal at all', async () => {
    const { cookies, header } = await validPair()
    const event = createEvent({
      cookies,
      requestHeaders: { host: 'app.test', [CSRF_HEADER_NAME]: header },
    })

    expect((await refusalOf(event))?.data).toMatchObject({ reason: 'no-origin' })
  })

  it('refuses a same-origin write with no header, and says where to get one', async () => {
    const { cookies } = await validPair()
    const refusal = await refusalOf(createEvent({ cookies }))

    expect(refusal?.data).toMatchObject({ reason: 'missing-header' })
    expect(refusal?.message).toContain(CSRF_HEADER_NAME)
  })

  it('refuses a same-origin write with no cookie', async () => {
    const event = createEvent({
      requestHeaders: {
        host: 'app.test',
        origin: 'https://app.test',
        [CSRF_HEADER_NAME]: 'anything',
      },
    })

    expect((await refusalOf(event))?.data).toMatchObject({ reason: 'missing-cookie' })
  })

  it('refuses a cookie this server did not sign, however well-formed it looks', async () => {
    const forged = await mintCsrfToken({ key: await deriveCsrfKey(OTHER_SECRET) })
    const event = createEvent({
      cookies: { [CSRF_COOKIE_NAME]: forged },
      requestHeaders: {
        host: 'app.test',
        origin: 'https://app.test',
        [CSRF_HEADER_NAME]: forged,
      },
    })

    expect((await refusalOf(event))?.data).toMatchObject({ reason: 'token-invalid' })
  })

  it('refuses a header that does not equal the cookie', async () => {
    const { cookies } = await validPair()
    const other = await mintCsrfToken({ key })
    const event = createEvent({
      cookies,
      requestHeaders: {
        host: 'app.test',
        origin: 'https://app.test',
        [CSRF_HEADER_NAME]: other,
      },
    })

    expect((await refusalOf(event))?.data).toMatchObject({ reason: 'mismatched-token' })
  })

  it('checks the vitals beacon on origin alone, because sendBeacon sends no header', async () => {
    const event = createEvent({ path: '/api/vitals' })

    await expect(refusalOf(event)).resolves.toBeNull()
  })

  it('still refuses a cross-origin vitals beacon', async () => {
    const event = createEvent({
      path: '/api/vitals',
      requestHeaders: { host: 'app.test', origin: 'https://evil.test' },
    })

    expect((await refusalOf(event))?.data).toMatchObject({ reason: 'cross-origin' })
  })

  it('lets useUserSession().clear() through, which cannot carry a header', async () => {
    // `nuxt-auth-utils` calls DELETE /api/_auth/session from inside its own
    // composable. Origin-only, and still refused cross-origin — see the next
    // assertion.
    const event = createEvent({ path: '/api/_auth/session', method: 'DELETE' })

    await expect(refusalOf(event)).resolves.toBeNull()
  })

  it('still refuses a cross-origin forced logout', async () => {
    const event = createEvent({
      path: '/api/_auth/session',
      method: 'DELETE',
      requestHeaders: { host: 'app.test', origin: 'https://evil.test' },
    })

    expect((await refusalOf(event))?.data).toMatchObject({ reason: 'cross-origin' })
  })

  it('does not exempt the logout route that really ends a session', async () => {
    const event = createEvent({ path: '/api/auth/logout' })

    expect((await refusalOf(event))?.data).toMatchObject({ reason: 'missing-cookie' })
  })

  it('guards paths outside /api too, which the access policy leaves unmanaged', async () => {
    const event = createEvent({
      path: '/some/page',
      requestHeaders: { host: 'app.test', origin: 'https://evil.test' },
    })

    expect((await refusalOf(event))?.data).toMatchObject({ reason: 'cross-origin' })
  })

  it('matches the exemption against the normalised path, not the raw one', async () => {
    // `/api/vitals/%2e%2e/todos` reaches the todos handler. If the gate matched
    // the raw path it would read as the origin-only vitals route and skip the
    // token.
    const event = createEvent({ path: '/api/vitals/%2e%2e/todos' })

    expect((await refusalOf(event))?.data).toMatchObject({ reason: 'missing-cookie' })
  })

  it('writes no cookie on a request it refuses', async () => {
    const event = createEvent({
      requestHeaders: { host: 'app.test', origin: 'https://evil.test' },
    })

    await refusalOf(event)

    expect(event.setCookies).toEqual({})
  })
})

describe('issuance', () => {
  it('writes a verifiable token on a document response', async () => {
    const event = createEvent({
      path: '/dashboard',
      method: 'GET',
      requestHeaders: { host: 'app.test', 'sec-fetch-dest': 'document' },
    })

    await run(event)

    const issued = event.setCookies[CSRF_COOKIE_NAME]
    expect(issued).toBeDefined()
    await expect(inspectCsrfToken(issued?.value, { key })).resolves.toMatchObject({
      status: 'valid',
    })
  })

  it('writes a cookie a script can read and a sibling host cannot set', async () => {
    const event = createEvent(
      {
        path: '/dashboard',
        method: 'GET',
        requestHeaders: {
          host: 'app.test',
          'sec-fetch-dest': 'document',
          'x-forwarded-proto': 'https',
        },
      },
      { encrypted: true },
    )

    await run(event)

    // `__Host-` is only accepted with Secure and Path=/ and no Domain, which is
    // what makes it unsettable from another host — see types/csrf.ts.
    const issued = event.setCookies[CSRF_COOKIE_SECURE_NAME]
    expect(issued?.options).toMatchObject({
      httpOnly: false,
      secure: true,
      sameSite: 'lax',
      path: '/',
    })
    expect(issued?.options['domain']).toBeUndefined()
    expect(event.setCookies[CSRF_COOKIE_NAME]).toBeUndefined()
  })

  it('falls back to the unprefixed name over plain HTTP, which is dev', async () => {
    const event = createEvent({
      path: '/dashboard',
      method: 'GET',
      requestHeaders: { host: 'localhost:3000', 'sec-fetch-dest': 'document' },
    })

    await run(event)

    expect(event.setCookies[CSRF_COOKIE_NAME]?.options).toMatchObject({ secure: false })
    expect(event.setCookies[CSRF_COOKIE_SECURE_NAME]).toBeUndefined()
  })

  it('leaves a still-good token alone, so two tabs do not race the cookie jar', async () => {
    const { cookies } = await validPair()
    const event = createEvent({
      path: '/dashboard',
      method: 'GET',
      cookies,
      requestHeaders: { host: 'app.test', 'sec-fetch-dest': 'document' },
    })

    await run(event)

    expect(event.setCookies).toEqual({})
  })

  it('replaces a token that is past half its life', async () => {
    const ttl = 3600
    runtimeConfig = {
      session: { password: SECRET },
      security: { csrf: { tokenTtlSeconds: ttl } },
    }

    const old = await mintCsrfToken({ key, ttlSeconds: ttl, now: Date.now() - ttl * 600 })
    const event = createEvent({
      path: '/dashboard',
      method: 'GET',
      cookies: { [CSRF_COOKIE_NAME]: old },
      requestHeaders: { host: 'app.test', 'sec-fetch-dest': 'document' },
    })

    await run(event)

    expect(event.setCookies[CSRF_COOKIE_NAME]?.value).toBeDefined()
    expect(event.setCookies[CSRF_COOKIE_NAME]?.value).not.toBe(old)
  })

  it('writes nothing on a request for a script or an image', async () => {
    const event = createEvent({
      path: '/_nuxt/entry.js',
      method: 'GET',
      requestHeaders: { host: 'app.test', 'sec-fetch-dest': 'script' },
    })

    await run(event)

    expect(event.setCookies).toEqual({})
  })

  it('writes nothing on a page whose HTML is shared between visitors', async () => {
    // `/route-rules/static` is prerendered, so a Set-Cookie on it would be one
    // visitor's token served to everyone after them.
    const event = createEvent({
      path: '/route-rules/static',
      method: 'GET',
      requestHeaders: { host: 'app.test', 'sec-fetch-dest': 'document' },
    })

    await run(event)

    expect(event.setCookies).toEqual({})
  })

  it('writes nothing on the mint endpoint, which issues its own', async () => {
    const event = createEvent({
      path: '/api/auth/csrf',
      method: 'GET',
      requestHeaders: { host: 'app.test', 'sec-fetch-dest': 'empty' },
    })

    await run(event)

    expect(event.setCookies).toEqual({})
  })

  it('falls back to Accept for a client that sends no Sec-Fetch-Dest', async () => {
    const event = createEvent({
      path: '/dashboard',
      method: 'GET',
      requestHeaders: { host: 'app.test', accept: 'text/html,application/xhtml+xml' },
    })

    await run(event)

    expect(event.setCookies[CSRF_COOKIE_NAME]).toBeDefined()
  })
})

describe('a server with no seal key', () => {
  beforeEach(() => {
    runtimeConfig = {}
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  it('lets requests through rather than failing, because there are no sessions to forge', async () => {
    const event = createEvent({
      requestHeaders: { host: 'app.test', origin: 'https://evil.test' },
    })

    await expect(refusalOf(event)).resolves.toBeNull()
  })

  it('says so once, not once per request', async () => {
    // A fresh copy of the module, because the latch that makes this "once" is
    // module scope and the test above has already tripped the one this file
    // imported. `defineEventHandler` is re-stubbed because it is read at
    // module-evaluation time and `vi.unstubAllGlobals()` in the afterEach takes
    // tests/setup.ts's version with it.
    vi.stubGlobal('defineEventHandler', <T>(fn: T): T => fn)
    vi.resetModules()
    const { default: fresh } = await import('~/server/middleware/20.csrf')
    const handler = fresh as unknown as (event: FakeEvent) => Promise<unknown>

    await handler(createEvent())
    await handler(createEvent())
    await handler(createEvent())

    expect(vi.mocked(console.warn).mock.calls).toHaveLength(1)
    expect(vi.mocked(console.warn).mock.calls[0]?.[0]).toContain('CSRF checks are not running')
  })
})
