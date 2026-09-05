import { createStorage, type Storage } from 'unstorage'
import memoryDriver from 'unstorage/drivers/memory'
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'

import {
  attachPrincipal,
  authorizeHandshake,
  extractTicket,
  isAllowedOrigin,
  parseAllowedOrigins,
  parseSubprotocols,
  readPrincipal,
  rejectionResponse,
  sessionReader,
  ticketSpender,
  type HandshakeDeps,
  type HandshakeRequestLike,
} from '~/server/utils/ws-handshake'
import { recordSession, revokeSession, type SessionRecord } from '~/server/utils/session-store'
import {
  burnTicket,
  deriveTicketKey,
  mintWsTicket,
  type BurnedTicket,
} from '~/server/utils/ws-ticket'
import { WS_TICKET_SUBPROTOCOL } from '~/types/websocket'

/**
 * The handshake is tested against real tickets, a real `unstorage`, and the real
 * session registry, with only the clock injected.
 *
 * Mocking `verifyWsTicket` would have made most of this vacuous: the point of
 * `authorizeHandshake` is the *order* the checks run in and the fact that each
 * one can refuse, and a stub that returns whatever the test wants proves neither.
 */
const SECRET = 'test-only-session-password-not-a-secret!!'
const NOW = 1_800_000_000_000
const SELF = 'http://app.test/api/ws/echo'

let key: Uint8Array
let sessions: Storage<SessionRecord>
let tickets: Storage<BurnedTicket>

beforeEach(async () => {
  key = await deriveTicketKey(SECRET)
  sessions = createStorage<SessionRecord>({ driver: memoryDriver() })
  tickets = createStorage<BurnedTicket>({ driver: memoryDriver() })

  await recordSession(sessions, {
    userId: 'user-1',
    sessionId: 'sess-1',
    provider: 'credentials',
    maxAgeSeconds: 3600,
    now: NOW,
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

async function ticketFor(overrides: { userId?: string; sessionId?: string } = {}): Promise<string> {
  const { token } = await mintWsTicket({
    key,
    userId: overrides.userId ?? 'user-1',
    sessionId: overrides.sessionId ?? 'sess-1',
    channel: 'echo',
    now: NOW,
  })
  return token
}

function request(init: {
  url?: string
  headers?: Record<string, string>
}): HandshakeRequestLike & { context: Record<string, unknown> } {
  return {
    url: init.url ?? SELF,
    headers: new Headers(init.headers ?? {}),
    context: {},
  }
}

function deps(overrides: Partial<HandshakeDeps> = {}): HandshakeDeps {
  return {
    key,
    channel: 'echo',
    now: NOW,
    readSession: sessionReader(sessions),
    spendTicket: ticketSpender(tickets, NOW),
    ...overrides,
  }
}

describe('parseSubprotocols', () => {
  it('splits and trims, dropping the empties a stray comma leaves', () => {
    expect(parseSubprotocols('a, b ,,c')).toEqual(['a', 'b', 'c'])
    expect(parseSubprotocols(null)).toEqual([])
    expect(parseSubprotocols('')).toEqual([])
  })
})

describe('extractTicket', () => {
  it('reads the token from the subprotocol list, after the marker', () => {
    const req = request({
      headers: { 'sec-websocket-protocol': `${WS_TICKET_SUBPROTOCOL}, tok-1` },
    })
    expect(extractTicket(req)).toEqual({ token: 'tok-1', via: 'subprotocol' })
  })

  it('reads the token from the query string when no marker is offered', () => {
    expect(extractTicket(request({ url: `${SELF}?ticket=tok-2` }))).toEqual({
      token: 'tok-2',
      via: 'query',
    })
  })

  it('prefers the subprotocol, the transport that does not reach an access log', () => {
    const req = request({
      url: `${SELF}?ticket=from-query`,
      headers: { 'sec-websocket-protocol': `${WS_TICKET_SUBPROTOCOL}, from-header` },
    })
    expect(extractTicket(req)).toEqual({ token: 'from-header', via: 'subprotocol' })
  })

  it('refuses a marker with nothing after it rather than falling back to the query', () => {
    // A client that got the subprotocol form half right should fail loudly, not
    // silently downgrade to the leakier transport.
    const req = request({
      url: `${SELF}?ticket=from-query`,
      headers: { 'sec-websocket-protocol': WS_TICKET_SUBPROTOCOL },
    })
    expect(extractTicket(req)).toBeNull()
  })

  it('ignores a subprotocol list that does not mention the marker', () => {
    const req = request({ headers: { 'sec-websocket-protocol': 'graphql-ws, json' } })
    expect(extractTicket(req)).toBeNull()
  })

  it('returns null when no ticket is presented at all', () => {
    expect(extractTicket(request({}))).toBeNull()
    expect(extractTicket(request({ url: `${SELF}?ticket=` }))).toBeNull()
  })
})

describe('isAllowedOrigin', () => {
  const req = request({ url: SELF })

  it('allows the app’s own host with no configuration', () => {
    expect(isAllowedOrigin('http://app.test', req)).toBe(true)
  })

  it('allows https from the same host, since the upgrade is http behind a terminator', () => {
    // The page is on `https://app.test`; crossws builds the handler's URL from
    // the `Host` header, so it says `http://app.test`. Comparing full origins
    // would refuse every TLS-terminated deployment.
    expect(isAllowedOrigin('https://app.test', req)).toBe(true)
  })

  it('refuses another host — this is the cross-site hijacking check', () => {
    expect(isAllowedOrigin('https://evil.example', req)).toBe(false)
  })

  it('treats a different port as a different origin', () => {
    expect(isAllowedOrigin('http://app.test:8080', req)).toBe(false)
  })

  it('allows a configured extra origin', () => {
    expect(isAllowedOrigin('https://front.test', req, ['https://front.test'])).toBe(true)
    expect(isAllowedOrigin('https://front.test', req, ['https://other.test'])).toBe(false)
  })

  it('compares the configured entry as an origin, not as a string', () => {
    expect(isAllowedOrigin('https://front.test', req, ['https://front.test/app'])).toBe(true)
  })

  it('allows a missing Origin, which is what a non-browser client sends', () => {
    // Requiring the header would break every CLI client while stopping no
    // attacker: anything outside a browser can send any Origin it likes.
    expect(isAllowedOrigin(null, req)).toBe(true)
    expect(isAllowedOrigin('', req)).toBe(true)
  })

  it('refuses an unparseable Origin, including the literal "null"', () => {
    // A sandboxed iframe and a `file://` page both send `Origin: null`.
    expect(isAllowedOrigin('null', req)).toBe(false)
    expect(isAllowedOrigin('not a url', req)).toBe(false)
  })
})

describe('parseAllowedOrigins', () => {
  it('splits the comma-separated form a NUXT_* variable arrives as', () => {
    expect(parseAllowedOrigins('https://a.test, https://b.test')).toEqual([
      'https://a.test',
      'https://b.test',
    ])
  })

  it('accepts an array and an absent value alike', () => {
    expect(parseAllowedOrigins(['https://a.test'])).toEqual(['https://a.test'])
    expect(parseAllowedOrigins(undefined)).toEqual([])
    expect(parseAllowedOrigins('')).toEqual([])
  })
})

describe('authorizeHandshake', () => {
  it('admits a ticket presented over the subprotocol', async () => {
    const token = await ticketFor()
    const result = await authorizeHandshake(
      request({
        headers: {
          origin: 'https://app.test',
          'sec-websocket-protocol': `${WS_TICKET_SUBPROTOCOL}, ${token}`,
        },
      }),
      deps(),
    )

    expect(result).toMatchObject({
      ok: true,
      principal: {
        userId: 'user-1',
        sessionId: 'sess-1',
        channel: 'echo',
        via: 'subprotocol',
        replayCheck: 'fresh',
        connectedAt: NOW,
        sessionExpiresAt: NOW + 3600 * 1000,
      },
    })
  })

  it('admits a ticket presented in the query string', async () => {
    const token = await ticketFor()
    const result = await authorizeHandshake(request({ url: `${SELF}?ticket=${token}` }), deps())
    expect(result).toMatchObject({ ok: true, principal: { via: 'query' } })
  })

  it('refuses a handshake with no ticket, however good the cookie would have been', async () => {
    // The whole point: the session cookie is attached to a cross-origin
    // handshake by the browser, so it cannot be what admits the socket.
    const result = await authorizeHandshake(
      request({ headers: { cookie: 'nuxt-session=whatever' } }),
      deps(),
    )
    expect(result).toEqual({ ok: false, rejection: { status: 401, reason: 'no-ticket' } })
  })

  it('refuses a foreign origin before looking at the ticket', async () => {
    const token = await ticketFor()
    const spendTicket = vi.fn()

    const result = await authorizeHandshake(
      request({
        url: `${SELF}?ticket=${token}`,
        headers: { origin: 'https://evil.example' },
      }),
      deps({ spendTicket }),
    )

    expect(result).toEqual({ ok: false, rejection: { status: 403, reason: 'forbidden-origin' } })
    // An unauthenticated caller must not be able to make the app do I/O by
    // opening sockets.
    expect(spendTicket).not.toHaveBeenCalled()
  })

  it('does not touch the stores for a ticket that never verified', async () => {
    const spendTicket = vi.fn()
    const readSession = vi.fn()

    await authorizeHandshake(
      request({ url: `${SELF}?ticket=nonsense` }),
      deps({ spendTicket, readSession }),
    )

    expect(spendTicket).not.toHaveBeenCalled()
    expect(readSession).not.toHaveBeenCalled()
  })

  it('spends the ticket, so the same handshake cannot be replayed', async () => {
    const token = await ticketFor()
    const replay = () => authorizeHandshake(request({ url: `${SELF}?ticket=${token}` }), deps())

    expect(await replay()).toMatchObject({ ok: true })
    expect(await replay()).toEqual({
      ok: false,
      rejection: { status: 401, reason: 'ticket-replayed' },
    })
  })

  it('refuses an expired ticket', async () => {
    const token = await ticketFor()
    const result = await authorizeHandshake(
      request({ url: `${SELF}?ticket=${token}` }),
      deps({ now: NOW + 120_000 }),
    )
    expect(result).toEqual({ ok: false, rejection: { status: 401, reason: 'ticket-expired' } })
  })

  it('refuses a ticket signed with someone else’s key', async () => {
    const token = await ticketFor()
    const result = await authorizeHandshake(
      request({ url: `${SELF}?ticket=${token}` }),
      deps({ key: await deriveTicketKey('another-test-only-password-of-32-chars!!!') }),
    )
    expect(result).toEqual({
      ok: false,
      rejection: { status: 401, reason: 'ticket-bad-signature' },
    })
  })

  it('refuses a valid ticket whose session was revoked', async () => {
    // The reason this check is here at all: `10.auth.ts` never runs for an
    // upgrade, so without it a revoked session could still open a socket that
    // stays open for hours.
    const token = await ticketFor()
    await revokeSession(sessions, 'user-1', 'sess-1', NOW)

    const result = await authorizeHandshake(request({ url: `${SELF}?ticket=${token}` }), deps())
    expect(result).toEqual({ ok: false, rejection: { status: 401, reason: 'session-revoked' } })
  })

  it('refuses a valid ticket whose session has expired', async () => {
    const token = await ticketFor()
    const afterExpiry = NOW + 3600 * 1000 + 1

    // The ticket is minted at `afterExpiry` so it is the *session*, not the
    // ticket, that has run out.
    const { token: fresh } = await mintWsTicket({
      key,
      userId: 'user-1',
      sessionId: 'sess-1',
      channel: 'echo',
      now: afterExpiry,
    })
    expect(token).not.toBe(fresh)

    const result = await authorizeHandshake(
      request({ url: `${SELF}?ticket=${fresh}` }),
      deps({ now: afterExpiry }),
    )
    expect(result).toEqual({ ok: false, rejection: { status: 401, reason: 'session-revoked' } })
  })

  it('admits a session the registry has never heard of, and says it has no expiry', async () => {
    // Fail-open, matching `sessionStatus`: a session predating the registry, or
    // one the store cannot produce, is `unknown` rather than denied.
    const { token } = await mintWsTicket({
      key,
      userId: 'user-1',
      sessionId: 'not-registered',
      channel: 'echo',
      now: NOW,
    })

    const result = await authorizeHandshake(request({ url: `${SELF}?ticket=${token}` }), deps())
    expect(result).toMatchObject({
      ok: true,
      principal: { sessionExpiresAt: Number.POSITIVE_INFINITY },
    })
  })

  it('reports an unchecked replay guard instead of hiding it', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(tickets, 'hasItem').mockRejectedValue(new Error('ECONNREFUSED'))
    const token = await ticketFor()

    const result = await authorizeHandshake(request({ url: `${SELF}?ticket=${token}` }), deps())

    expect(result).toMatchObject({ ok: true, principal: { replayCheck: 'unchecked' } })
    expect(consoleError).toHaveBeenCalled()
  })

  it('admits the handshake when the session registry is unreachable', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(sessions, 'getItem').mockRejectedValue(new Error('ECONNREFUSED'))
    const token = await ticketFor()

    const result = await authorizeHandshake(request({ url: `${SELF}?ticket=${token}` }), deps())

    expect(result).toMatchObject({ ok: true })
    expect(consoleError).toHaveBeenCalled()
  })

  it('checks the ticket against the channel the route serves', async () => {
    const token = await ticketFor()
    const result = await authorizeHandshake(
      request({ url: `${SELF}?ticket=${token}` }),
      // A route serving a channel the ticket was not minted for. The union has
      // one member today, so this is the shape a second channel would take.
      deps({ channel: 'chat' as 'echo' }),
    )
    expect(result).toEqual({
      ok: false,
      rejection: { status: 401, reason: 'ticket-wrong-channel' },
    })
  })
})

describe('rejectionResponse', () => {
  it('is a real Response with a 4xx status — the only shape crossws rejects on', async () => {
    // crossws proceeds unless `res.ok === false`, a property a `ResponseInit`
    // does not have. Returning `{ status: 401 }` type-checks and opens the
    // socket, which is the bug this function exists to make unwritable.
    const response = rejectionResponse({ status: 401, reason: 'no-ticket' })

    expect(response).toBeInstanceOf(Response)
    expect(response.ok).toBe(false)
    expect(response.status).toBe(401)
  })

  it('tells the client nothing about why', async () => {
    const unauthorized = rejectionResponse({ status: 401, reason: 'ticket-expired' })
    const forged = rejectionResponse({ status: 401, reason: 'ticket-bad-signature' })

    expect(await unauthorized.text()).toBe(await forged.text())
  })

  it('names 403 as forbidden and everything else as unauthorized', () => {
    expect(rejectionResponse({ status: 403, reason: 'forbidden-origin' }).statusText).toBe(
      'Forbidden',
    )
    expect(rejectionResponse({ status: 401, reason: 'no-ticket' }).statusText).toBe('Unauthorized')
  })
})

describe('attachPrincipal / readPrincipal', () => {
  const principal = {
    userId: 'user-1',
    sessionId: 'sess-1',
    channel: 'echo',
    ticketId: 't-1',
    connectedAt: NOW,
    sessionExpiresAt: NOW + 1000,
    via: 'query',
    replayCheck: 'fresh',
  } as const

  it('round-trips through the context object crossws hands to the peer', () => {
    const context: Record<string, unknown> = {}
    expect(attachPrincipal(context, principal)).toBe(true)
    expect(readPrincipal(context)).toEqual(principal)
  })

  it('mutates rather than replaces, because crossws makes the property read-only', () => {
    // `Object.defineProperty(request, 'context', { value })` with no `writable`,
    // so `request.context = {…}` throws in a module's strict-mode scope. This
    // pins that the implementation writes a key instead of the object.
    const req: { readonly context: Record<string, unknown> } = { context: {} }
    Object.defineProperty(req, 'context', { value: req.context, writable: false })

    expect(() => attachPrincipal(req.context, principal)).not.toThrow()
    expect(readPrincipal(req.context)).toEqual(principal)
  })

  it('refuses rather than invents a context that is missing', () => {
    expect(attachPrincipal(undefined, principal)).toBe(false)
  })

  it('reads null from a peer that carries no principal', () => {
    expect(readPrincipal(undefined)).toBeNull()
    expect(readPrincipal({})).toBeNull()
    expect(readPrincipal({ principal: 'user-1' })).toBeNull()
    expect(readPrincipal({ principal: { userId: 'user-1' } })).toBeNull()
  })
})

describe('sessionReader / ticketSpender', () => {
  it('binds the real stores without the caller naming a key format', async () => {
    const read = sessionReader(sessions)
    expect(await read('user-1', 'sess-1')).toMatchObject({ userId: 'user-1' })
    expect(await read('user-1', 'nope')).toBeNull()
  })

  it('spends through the same path burnTicket uses directly', async () => {
    const { claims } = await mintWsTicket({
      key,
      userId: 'user-1',
      sessionId: 'sess-1',
      channel: 'echo',
      now: NOW,
    })

    expect(await ticketSpender(tickets, NOW)(claims)).toBe('fresh')
    expect(await burnTicket(tickets, claims, NOW)).toBe('replayed')
  })
})
