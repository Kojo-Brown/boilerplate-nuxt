import {
  burnTicket,
  verifyWsTicket,
  type BurnedTicket,
  type TicketBurn,
  type WsTicketClaims,
  type WsTicketFailure,
} from '~/server/utils/ws-ticket'
import { readSessionRecord, sessionStatus, type SessionRecord } from '~/server/utils/session-store'
import { WS_TICKET_QUERY_PARAM, WS_TICKET_SUBPROTOCOL, type WsChannel } from '~/types/websocket'
import type { Storage } from 'unstorage'

/**
 * The WebSocket handshake gate — the `upgrade` half of `server/api/ws/echo.ts`.
 *
 * ## The gate this replaces does not run
 *
 * `server/utils/access-policy.ts` is a default-deny table over `/api/**` and
 * `server/middleware/10.auth.ts` enforces it. Neither applies here, and the
 * reason is structural rather than an oversight. In the Node preset Nitro wires
 * the HTTP listener and the upgrade listener to different things:
 *
 * ```js
 * const server = new HttpServer(toNodeListener(nitroApp.h3App))   // requests
 * server.on('upgrade', wsAdapter(nitroApp.h3App.websocket).handleUpgrade)
 * ```
 *
 * `handleUpgrade` resolves a route's `__websocket__` hooks by pathname and calls
 * them. It does not build an `H3Event`, so it does not enter the middleware
 * chain: `00.request-context.ts` never assigns a request id, `10.auth.ts` never
 * resolves a session, and `event.context.auth` does not exist. A WebSocket route
 * is outside every server-side guard this app has unless it carries its own —
 * which is the same category error `middleware/auth.global.ts` embodied before
 * PR #29, one protocol further along.
 *
 * That is why {@link authorizeHandshake} re-checks in one place everything the
 * middleware would have: the credential, the session's revocation status, and
 * the caller's origin.
 *
 * ## Rejecting is not obvious either
 *
 * crossws decides what an `upgrade` hook meant by inspecting what it returned:
 *
 * ```js
 * const res = await this.callHook('upgrade', request)
 * if (!res) return { context }                            // proceed
 * if (res.ok === false) return { context, endResponse: res }  // reject
 * if (res.headers) return { context, upgradeHeaders: res.headers }  // proceed
 * return { context }                                       // proceed
 * ```
 *
 * Only the second line rejects, and `res.ok` is a property of `Response`, not of
 * `ResponseInit`. So returning `{ status: 401 }` — which is a perfectly good
 * `ResponseInit`, which the hook's type accepts, and which reads like a
 * rejection — **completes the upgrade**. The socket opens, the client sees
 * `onopen`, and the endpoint is unauthenticated. {@link rejectionResponse}
 * exists so that no caller ever has the chance to write that line: it always
 * returns a real `Response` with a 4xx status.
 *
 * ## Where the identity goes
 *
 * `request.context` is the object crossws hands to the peer as `peer.context`,
 * so writing the resolved principal onto it is how the socket's whole lifetime
 * learns who is on the other end. It has to be *mutated*: crossws installs it
 * with `Object.defineProperty(request, 'context', { value })` and no `writable`,
 * so `request.context = {…}` throws a `TypeError` in the module's strict-mode
 * scope. {@link attachPrincipal} is the mutation, in one place, with this note
 * attached to it.
 */

/** What {@link authorizeHandshake} needs from the upgrade request. */
export interface HandshakeRequestLike {
  /** Absolute URL — crossws builds one from the `Host` header and `req.url`. */
  readonly url: string
  readonly headers: Headers
}

/** The identity a socket carries for its lifetime, on `peer.context.principal`. */
export interface WsPrincipal {
  readonly userId: string
  readonly sessionId: string
  readonly channel: WsChannel
  readonly ticketId: string
  /** Epoch milliseconds the handshake completed. */
  readonly connectedAt: number
  /**
   * Epoch milliseconds the *session* expires — not the ticket, which is spent by
   * the time this exists. A socket must not outlive the credential that opened
   * it; `server/api/ws/echo.ts` closes on this.
   */
  readonly sessionExpiresAt: number
  /** How the ticket reached the server. Logged, never trusted. */
  readonly via: TicketTransport
  /** `unchecked` means the replay guard could not answer. See {@link burnTicket}. */
  readonly replayCheck: TicketBurn
}

export type TicketTransport = 'subprotocol' | 'query'

/** Why a handshake was refused. Logged server-side; never sent to the client. */
export type HandshakeFailure =
  | 'no-ticket'
  | 'forbidden-origin'
  | 'ticket-replayed'
  | 'session-revoked'
  | `ticket-${WsTicketFailure}`

export interface HandshakeRejection {
  readonly status: number
  readonly reason: HandshakeFailure
}

export type HandshakeResult =
  | { readonly ok: true; readonly principal: WsPrincipal }
  | { readonly ok: false; readonly rejection: HandshakeRejection }

/**
 * The store lookups {@link authorizeHandshake} makes, as functions rather than a
 * `Storage`, so a test substitutes two closures instead of a driver.
 */
export interface HandshakeDeps {
  readonly key: Uint8Array
  /** The channel this route serves. Checked against the ticket's `aud`. */
  readonly channel: WsChannel
  /**
   * Origins allowed in addition to the request's own host. Empty means
   * same-origin only.
   */
  readonly allowedOrigins?: readonly string[]
  /** Injected so tests do not depend on the wall clock. */
  readonly now?: number
  /** Reads the session registry record, or `null` when there is none. */
  readonly readSession: (
    userId: string,
    sessionId: string,
  ) => Promise<SessionRecord | null> | SessionRecord | null
  /** Records the ticket as spent. */
  readonly spendTicket: (claims: WsTicketClaims) => Promise<TicketBurn> | TicketBurn
}

/**
 * Reads the ticket out of a handshake.
 *
 * The subprotocol list is preferred and checked first. A `Sec-Websocket-Protocol`
 * header is not written to an access log by default, is not a referrer, and does
 * not survive into a browser history entry — all of which a query string does.
 * The list is `<marker>, <token>` in that order because the server selects the
 * first protocol offered, and a `101` that echoed the *token* back would put the
 * credential in the response as well as the request.
 *
 * Returns `null` when a marker is offered with no token after it, rather than
 * falling through to the query string: a client that got the subprotocol form
 * half right should fail loudly, not silently use the leakier transport.
 */
export function extractTicket(
  request: HandshakeRequestLike,
): { readonly token: string; readonly via: TicketTransport } | null {
  const offered = parseSubprotocols(request.headers.get('sec-websocket-protocol'))
  const markerAt = offered.indexOf(WS_TICKET_SUBPROTOCOL)

  if (markerAt !== -1) {
    const token = offered[markerAt + 1]
    return token === undefined || token === '' ? null : { token, via: 'subprotocol' }
  }

  const fromQuery = safeUrl(request.url)?.searchParams.get(WS_TICKET_QUERY_PARAM)
  if (fromQuery === null || fromQuery === undefined || fromQuery === '') return null

  return { token: fromQuery, via: 'query' }
}

/** `a, b ,c` → `['a', 'b', 'c']`, dropping the empty entries a stray comma makes. */
export function parseSubprotocols(header: string | null): string[] {
  if (!header) return []
  return header
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
}

/**
 * Decides whether a handshake's `Origin` is allowed.
 *
 * A browser sets `Origin` on a WebSocket handshake and cannot be made to lie
 * about it, so for browser traffic this is a real check — and it is the *only*
 * defence against a cross-origin page that has somehow obtained a ticket, since
 * nothing else about the handshake distinguishes one page from another.
 *
 * A missing `Origin` is allowed. That is not a hole being waved through: a
 * non-browser client (a CLI, a service, `wscat`) sends no `Origin`, and one that
 * wants to can send any value it likes. Requiring the header would break every
 * legitimate non-browser client while stopping no attacker who is not already
 * confined by a browser. The credential is what authenticates the caller; the
 * origin check is what stops a browser being used as a confused deputy.
 *
 * Comparison is on the serialised origin, so scheme and port are part of it:
 * `http://app.test` and `https://app.test` are different origins, which is the
 * whole point of the term. The request's own host is always allowed, which makes
 * same-origin work with no configuration on any hostname the app is deployed to.
 */
export function isAllowedOrigin(
  origin: string | null,
  request: HandshakeRequestLike,
  allowed: readonly string[] = [],
): boolean {
  if (origin === null || origin === '') return true

  const parsed = safeUrl(origin)
  if (parsed === null) return false

  if (allowed.some((entry) => normaliseOrigin(entry) === parsed.origin)) return true

  // Same-origin: the handshake URL crossws built from the `Host` header. Hosts
  // are compared, not full origins, because the upgrade is `ws:` behind a TLS
  // terminator far more often than it is `wss:` end to end — a page on
  // `https://app.test` reaches a handler whose own URL says `http://app.test`.
  const self = safeUrl(request.url)
  return self !== null && self.host === parsed.host
}

/** Splits `NUXT_WS_ALLOWED_ORIGINS` into origins. Also accepts an array. */
export function parseAllowedOrigins(raw: string | readonly string[] | undefined): string[] {
  const entries = typeof raw === 'string' ? raw.split(',') : (raw ?? [])
  return entries.map((entry) => entry.trim()).filter((entry) => entry !== '')
}

/**
 * Runs the whole gate: credential, origin, replay, revocation.
 *
 * The order is deliberate. The origin check is first because it is free and
 * needs no secret; the signature is checked before the store is touched, so an
 * unauthenticated caller cannot make this app do I/O by opening sockets; and the
 * revocation read happens last, because it is the only step that costs a round
 * trip and there is no point paying it for a ticket that was never valid.
 */
export async function authorizeHandshake(
  request: HandshakeRequestLike,
  deps: HandshakeDeps,
): Promise<HandshakeResult> {
  const now = deps.now ?? Date.now()

  if (!isAllowedOrigin(request.headers.get('origin'), request, deps.allowedOrigins)) {
    return reject(403, 'forbidden-origin')
  }

  const presented = extractTicket(request)
  if (presented === null) return reject(401, 'no-ticket')

  const verified = await verifyWsTicket(presented.token, {
    key: deps.key,
    channel: deps.channel,
    now,
  })
  if (!verified.ok) return reject(401, `ticket-${verified.reason}`)

  const { claims } = verified

  const replayCheck = await deps.spendTicket(claims)
  if (replayCheck === 'replayed') return reject(401, 'ticket-replayed')

  // The session registry, for the same reason `10.auth.ts` reads it on every
  // authenticated request: a sealed credential stays cryptographically valid
  // until it expires, so revocation is the only thing that can end it early. A
  // socket is where that matters most — an HTTP request checked at t=0 is over,
  // while a socket admitted at t=0 can still be open an hour later.
  const record = await deps.readSession(claims.userId, claims.sessionId)
  const status = sessionStatus(record, now)
  if (status === 'revoked' || status === 'expired') {
    return reject(401, 'session-revoked')
  }

  return {
    ok: true,
    principal: {
      userId: claims.userId,
      sessionId: claims.sessionId,
      channel: claims.channel,
      ticketId: claims.ticketId,
      connectedAt: now,
      // `unknown` is a session issued before the registry existed, or one whose
      // record the store could not produce. `sessionStatus` lets it through for
      // the reasons `session-store.ts` gives, and the socket then has no expiry
      // of its own to enforce — the ticket already proved the cookie was valid
      // when it was minted, seconds ago.
      sessionExpiresAt: record?.expiresAt ?? Number.POSITIVE_INFINITY,
      via: presented.via,
      replayCheck,
    },
  }
}

/**
 * Builds the response that refuses an upgrade.
 *
 * Always a real `Response` with a 4xx status, because that is the only shape
 * crossws treats as a rejection — see this module's header. The body is a short
 * constant: the client is not a browser page that will render it, the reason
 * would be an oracle, and `sendResponse` in the crossws Node adapter
 * percent-encodes every header it writes, so anything structured is better in
 * the log than on the wire.
 */
export function rejectionResponse(rejection: HandshakeRejection): Response {
  return new Response('WebSocket upgrade refused\n', {
    status: rejection.status,
    statusText: rejection.status === 403 ? 'Forbidden' : 'Unauthorized',
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  })
}

/**
 * Puts the principal where the socket's hooks can read it, reporting whether it
 * landed.
 *
 * Mutation, not assignment: crossws defines `context` on the upgrade request as
 * a non-writable property before calling the hook, so `request.context = {…}`
 * throws a `TypeError` here — silently rejecting the upgrade with no response,
 * because a throw from the hook that is not a `Response` propagates out of
 * `handleUpgrade`.
 *
 * Returns `false` for a missing context rather than creating one. crossws
 * installs it before every `upgrade` call, so this is unreachable in the adapters
 * this app runs on — but the type admits `undefined`, a context this function
 * invented would not be the one the peer reads, and the caller's only safe
 * reading of "the identity has nowhere to go" is to refuse the socket.
 */
export function attachPrincipal(
  context: Record<string, unknown> | undefined,
  principal: WsPrincipal,
): boolean {
  if (context === undefined) return false
  context['principal'] = principal
  return true
}

/** Reads back what {@link attachPrincipal} wrote, or `null` on an unauthenticated peer. */
export function readPrincipal(context: Record<string, unknown> | undefined): WsPrincipal | null {
  const value = context?.['principal']
  if (value === null || typeof value !== 'object') return null

  const candidate = value as Partial<WsPrincipal>
  return typeof candidate.userId === 'string' && typeof candidate.sessionId === 'string'
    ? (value as WsPrincipal)
    : null
}

/** The `readSession` dep, bound to a real store. */
export function sessionReader(
  store: Storage<SessionRecord>,
): (userId: string, sessionId: string) => Promise<SessionRecord | null> {
  return async (userId, sessionId) => {
    try {
      return await readSessionRecord(store, userId, sessionId)
    } catch (error) {
      // Fail-open, matching `10.auth.ts`: an unreachable registry must not stop
      // people connecting. `sessionStatus(null)` is `unknown`, which is allowed.
      console.error('[ws] session registry unreachable, allowing handshake:', error)
      return null
    }
  }
}

/** The `spendTicket` dep, bound to a real store. */
export function ticketSpender(
  store: Storage<BurnedTicket>,
  now?: number,
): (claims: WsTicketClaims) => Promise<TicketBurn> {
  return (claims) => burnTicket(store, claims, now ?? Date.now())
}

function reject(status: number, reason: HandshakeFailure): HandshakeResult {
  return { ok: false, rejection: { status, reason } }
}

function normaliseOrigin(value: string): string | null {
  return safeUrl(value)?.origin ?? null
}

/** `new URL` throws on anything unparseable, including the literal `"null"` origin. */
function safeUrl(value: string): URL | null {
  try {
    return new URL(value)
  } catch {
    return null
  }
}
