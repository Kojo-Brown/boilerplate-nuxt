import { SignJWT, jwtVerify } from 'jose'
import type { errors as joseErrors } from 'jose'
import type { Storage } from 'unstorage'

import { SESSIONS_BASE } from '~/server/utils/storage'
import { isWsChannel, type WsChannel } from '~/types/websocket'

/**
 * Handshake tickets: short-lived, single-use JWTs that authenticate a WebSocket
 * upgrade.
 *
 * ## Why a second credential exists at all
 *
 * The app already has one: the sealed session cookie, checked on every managed
 * request by `server/middleware/10.auth.ts`. Reusing it for the socket looks
 * free — the browser attaches cookies to a WebSocket upgrade without being
 * asked — and that last clause is precisely the problem. **The WebSocket
 * handshake is not subject to the same-origin policy.** There is no preflight
 * and no `Access-Control-Allow-Origin` to withhold; `evil.example` can run
 * `new WebSocket('wss://this-app/api/ws/echo')` and the browser will send this
 * app's session cookie with it. If the cookie is what admits the socket, the
 * socket is admitted. That is cross-site WebSocket hijacking, and it is a
 * property of the protocol rather than of any mistake in this codebase.
 *
 * The fix is a credential the attacker's page cannot obtain. A ticket is minted
 * by `POST /api/ws/ticket`, which is an ordinary fetch — so it *is* governed by
 * CORS, it requires a JSON content type (which forces a preflight this app never
 * answers for a foreign origin), and its response body is unreadable
 * cross-origin even if the request somehow went through. An attacker's page can
 * still open the socket; it just cannot present a ticket, and the handshake in
 * `server/utils/ws-handshake.ts` rejects it before the `101`.
 *
 * ## Why a JWT, when the app already has a session store
 *
 * Because the alternative is a database round trip on a path that must not have
 * one. A signed ticket carries its own claims: the handshake verifies a
 * signature and reads the user id, the session id and the channel out of the
 * token itself. The store is consulted for exactly two things a token cannot
 * express — whether the session behind it was revoked in the last few seconds,
 * and whether this ticket has already been used — and both of those are cheap
 * key reads rather than a lookup that has to happen before anything else can.
 *
 * The signing key is not a new secret. It is derived from the session password
 * with HKDF (see {@link deriveTicketKey}), so there is one secret to deploy and
 * still two cryptographically unrelated keys: a ticket signature cannot be used
 * to forge a session cookie, and vice versa.
 *
 * ## What makes this ticket safe in a query string
 *
 * `types/websocket.ts` explains that a browser cannot set headers on a
 * handshake, so a token travels either in the subprotocol list or in the URL.
 * The URL is the leaky one — access logs, referrers, APM traces — and three
 * properties are what make it survivable rather than merely convenient:
 *
 *  - **Seconds, not minutes.** {@link DEFAULT_TICKET_TTL_SECONDS} is 30: long
 *    enough to fetch a ticket and open a socket, short enough that a token in
 *    yesterday's log is inert.
 *  - **Single use.** {@link burnTicket} records the `jti` on the first
 *    successful handshake, so replaying the same URL inside the window fails.
 *  - **One channel.** The `aud` claim names the channel it was minted for, and
 *    the handshake checks it against the route being upgraded.
 *
 * None of that makes a leaked ticket harmless. It makes a leaked *log* harmless,
 * which is the realistic failure.
 */

/** `iss` on every ticket, and the value the handshake requires. */
export const WS_TICKET_ISSUER = 'boilerplate-nuxt/ws'

/**
 * The one signature algorithm this app mints and the only one it will verify.
 *
 * Pinned at both ends on purpose. `jose` already refuses `alg: none` and will
 * not verify an asymmetric algorithm with a symmetric key, so this is not the
 * classic algorithm-confusion hole standing open — but "the library happens to
 * stop it" is a weaker statement than "the verifier accepts one algorithm", and
 * only the second one survives a dependency upgrade.
 */
export const WS_TICKET_ALG = 'HS256'

/**
 * `typ` on the protected header.
 *
 * A ticket is not an access token and must never be accepted as one. Giving it
 * an explicit media type means a verifier that ever ends up sharing a key can
 * tell the two apart structurally, which is the whole point of RFC 8725's advice
 * on explicit typing.
 */
export const WS_TICKET_TYP = 'ws-ticket+jwt'

/** Default lifetime of a ticket. Seconds, because that is the honest unit here. */
export const DEFAULT_TICKET_TTL_SECONDS = 30

/**
 * Ceiling on a ticket's lifetime.
 *
 * The TTL is configurable (`NUXT_WS_TICKET_TTL`) because a slow client on a bad
 * network can genuinely need more than 30 seconds between fetching a ticket and
 * completing an upgrade. It is clamped because a ticket is a bearer credential
 * in a URL, and there is no operational reason to want one that outlives the
 * page that asked for it.
 */
export const MAX_TICKET_TTL_SECONDS = 300

/**
 * Clock skew tolerated on `exp` and `nbf`, in seconds.
 *
 * The minting and verifying processes are usually the same one, so this is not
 * about this app disagreeing with itself. It is about a ticket minted on one
 * instance and redeemed on another a moment later, where the two nodes' clocks
 * differ by whatever NTP last allowed. Five seconds is small next to a 30-second
 * ticket and large next to any drift worth calling healthy.
 */
export const TICKET_CLOCK_TOLERANCE_SECONDS = 5

/** Key prefix for burned tickets on the `sessions` base. */
const BURNED_TICKET_PREFIX = 'ws-ticket'

/** HKDF context string. Changing it invalidates every outstanding ticket. */
const TICKET_KEY_INFO = 'nuxt-ws-handshake-ticket-v1'

/** The claims a verified ticket carries, in this app's own vocabulary. */
export interface WsTicketClaims {
  /** `sub` — `User['id']`. */
  readonly userId: string
  /** `sid` — the h3 session id, so the socket can be revoked with the session. */
  readonly sessionId: string
  /** `aud` — the channel this ticket may open. */
  readonly channel: WsChannel
  /** `jti` — the identifier {@link burnTicket} records to make it single-use. */
  readonly ticketId: string
  /** `iat`, in epoch milliseconds. */
  readonly issuedAt: number
  /** `exp`, in epoch milliseconds. */
  readonly expiresAt: number
}

export interface MintWsTicketInput {
  /** HMAC key from {@link deriveTicketKey}. */
  readonly key: Uint8Array
  readonly userId: string
  readonly sessionId: string
  readonly channel: WsChannel
  /** Clamped to {@link MAX_TICKET_TTL_SECONDS}. */
  readonly ttlSeconds?: number
  /** Injected so tests do not depend on the wall clock. */
  readonly now?: number
  /** Injected so a test can assert on a known `jti`. Defaults to a UUID v4. */
  readonly ticketId?: string
}

export interface MintedWsTicket {
  readonly token: string
  readonly claims: WsTicketClaims
}

/**
 * Derives the ticket-signing key from a secret with HKDF-SHA256.
 *
 * The secret is `runtimeConfig.session.password` unless an operator sets
 * `NUXT_WS_TICKET_SECRET`, and deriving rather than using it directly is what
 * keeps the two uses independent: HKDF's output tells you nothing about its
 * input, so a ticket and its signature are not a corpus for attacking the
 * session cookie's key, and {@link TICKET_KEY_INFO} guarantees the two keys
 * differ even though the secret does not.
 *
 * WebCrypto rather than `node:crypto` so the module runs unchanged on every
 * Nitro preset — the Cloudflare and Deno builds have no `node:crypto` HKDF, and
 * a handshake that only works on the Node preset is a handshake that fails on
 * exactly the platforms people reach for WebSockets on.
 *
 * The salt is empty, which HKDF defines as a string of zeros. A salt adds
 * nothing when the input is already a high-entropy secret used for one purpose
 * and the context string is fixed; a *random* salt would have to be stored and
 * shared across instances, which is a distributed-state problem bought for no
 * gain.
 */
export async function deriveTicketKey(secret: string): Promise<Uint8Array> {
  if (secret.length < 32) {
    throw new Error(
      'The WebSocket ticket secret must be at least 32 characters. It defaults to ' +
        'runtimeConfig.session.password (NUXT_SESSION_PASSWORD); set NUXT_WS_TICKET_SECRET to ' +
        'use a separate one.',
    )
  }

  const material = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    'HKDF',
    false,
    ['deriveBits'],
  )

  const bits = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(0),
      info: new TextEncoder().encode(TICKET_KEY_INFO),
    },
    material,
    256,
  )

  return new Uint8Array(bits)
}

/** Clamps a configured TTL into the supported range. */
export function clampTicketTtl(seconds: number | string | undefined): number {
  const value = Number(seconds)
  if (!Number.isFinite(value)) return DEFAULT_TICKET_TTL_SECONDS
  return Math.min(MAX_TICKET_TTL_SECONDS, Math.max(1, Math.floor(value)))
}

/**
 * Signs one ticket.
 *
 * `iat`, `nbf` and `exp` are whole seconds because that is what the JWT
 * specification defines them as; the claims returned alongside are milliseconds
 * because that is what the rest of this codebase uses for a timestamp, and
 * silently mixing the two units is how an expiry ends up 1000× too far away.
 */
export async function mintWsTicket(input: MintWsTicketInput): Promise<MintedWsTicket> {
  const now = input.now ?? Date.now()
  const ttlSeconds = clampTicketTtl(input.ttlSeconds)
  const issuedAtSeconds = Math.floor(now / 1000)
  const expiresAtSeconds = issuedAtSeconds + ttlSeconds
  const ticketId = input.ticketId ?? crypto.randomUUID()

  const token = await new SignJWT({ sid: input.sessionId })
    .setProtectedHeader({ alg: WS_TICKET_ALG, typ: WS_TICKET_TYP })
    .setIssuer(WS_TICKET_ISSUER)
    .setAudience(input.channel)
    .setSubject(input.userId)
    .setJti(ticketId)
    .setIssuedAt(issuedAtSeconds)
    .setNotBefore(issuedAtSeconds)
    .setExpirationTime(expiresAtSeconds)
    .sign(input.key)

  return {
    token,
    claims: {
      userId: input.userId,
      sessionId: input.sessionId,
      channel: input.channel,
      ticketId,
      issuedAt: issuedAtSeconds * 1000,
      expiresAt: expiresAtSeconds * 1000,
    },
  }
}

/**
 * Why a ticket did not verify.
 *
 * These distinctions are for the server's log and nothing else. The handshake
 * answers every one of them with the same `401` and the same body — an attacker
 * who can tell "expired" from "bad signature" has been handed an oracle, and the
 * legitimate client cannot act differently on any of them anyway: it fetches a
 * new ticket.
 */
export type WsTicketFailure =
  | 'malformed'
  | 'bad-signature'
  | 'expired'
  | 'not-yet-valid'
  | 'wrong-issuer'
  | 'wrong-channel'
  | 'unsupported-algorithm'
  | 'incomplete-claims'

export type WsTicketVerification =
  | { readonly ok: true; readonly claims: WsTicketClaims }
  | { readonly ok: false; readonly reason: WsTicketFailure }

export interface VerifyWsTicketOptions {
  readonly key: Uint8Array
  /** The channel the socket is being opened on — checked against `aud`. */
  readonly channel: WsChannel
  /** Injected so tests do not depend on the wall clock. */
  readonly now?: number
}

/**
 * Verifies a ticket against one channel, returning a reason rather than throwing.
 *
 * A rejected handshake is an ordinary outcome — an expired ticket is what a slow
 * page load looks like — so the failure path is a value the caller has to
 * handle, not an exception it may forget to catch. That matters more here than
 * in an HTTP handler: an uncaught throw inside the crossws `upgrade` hook does
 * not become a `500`, it rejects the socket with no response at all.
 */
export async function verifyWsTicket(
  token: string,
  options: VerifyWsTicketOptions,
): Promise<WsTicketVerification> {
  const now = options.now ?? Date.now()

  try {
    const { payload } = await jwtVerify(token, options.key, {
      algorithms: [WS_TICKET_ALG],
      typ: WS_TICKET_TYP,
      issuer: WS_TICKET_ISSUER,
      audience: options.channel,
      requiredClaims: ['sub', 'sid', 'jti', 'iat', 'exp'],
      clockTolerance: TICKET_CLOCK_TOLERANCE_SECONDS,
      currentDate: new Date(now),
    })

    const sessionId = payload['sid']
    // `aud` is already checked against `options.channel` above, so this narrows a
    // value that cannot fail — except that `aud` may legally be an array, and
    // `isWsChannel` is what keeps `claims.channel` a `WsChannel` rather than a
    // cast over `string | string[]`.
    const channel = typeof payload.aud === 'string' && isWsChannel(payload.aud) ? payload.aud : null

    if (
      typeof payload.sub !== 'string' ||
      typeof sessionId !== 'string' ||
      sessionId === '' ||
      typeof payload.jti !== 'string' ||
      typeof payload.iat !== 'number' ||
      typeof payload.exp !== 'number' ||
      channel === null
    ) {
      return { ok: false, reason: 'incomplete-claims' }
    }

    return {
      ok: true,
      claims: {
        userId: payload.sub,
        sessionId,
        channel,
        ticketId: payload.jti,
        issuedAt: payload.iat * 1000,
        expiresAt: payload.exp * 1000,
      },
    }
  } catch (error) {
    return { ok: false, reason: classifyTicketFailure(error) }
  }
}

/**
 * Maps a `jose` error onto {@link WsTicketFailure}.
 *
 * Switched on `code` rather than `instanceof`. There are two copies of `jose` in
 * a Nuxt app the moment a direct dependency and `nuxt-auth-utils`' own copy
 * resolve differently, and `instanceof` across two copies of the same class is
 * `false` — which would turn every expired ticket into `malformed` and lose the
 * one distinction the log is kept for. The `code` string is stable across copies
 * and across versions.
 */
function classifyTicketFailure(error: unknown): WsTicketFailure {
  const code = error instanceof Error ? (error as { code?: unknown }).code : undefined

  switch (code) {
    case 'ERR_JWT_EXPIRED':
      return 'expired'
    case 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED':
      return 'bad-signature'
    case 'ERR_JOSE_ALG_NOT_ALLOWED':
      return 'unsupported-algorithm'
    case 'ERR_JWT_CLAIM_VALIDATION_FAILED':
      return classifyClaimFailure(error)
    case 'ERR_JWS_INVALID':
    case 'ERR_JWT_INVALID':
      return 'malformed'
    default:
      return 'malformed'
  }
}

function classifyClaimFailure(error: unknown): WsTicketFailure {
  const claim = (error as joseErrors.JWTClaimValidationFailed).claim

  switch (claim) {
    case 'nbf':
      return 'not-yet-valid'
    case 'iss':
      return 'wrong-issuer'
    case 'aud':
      return 'wrong-channel'
    default:
      // `typ` on the header, or a claim `requiredClaims` says must be present.
      return 'incomplete-claims'
  }
}

// ─── Single use ──────────────────────────────────────────────────────────────

/** What a burned ticket record holds. Only its existence and TTL matter. */
export interface BurnedTicket {
  readonly userId: string
  readonly burnedAt: number
}

/**
 * The store seam, matching `useSessionStore()` next door.
 *
 * Burned tickets live on the `sessions` base rather than a third one because
 * they are auth state with a session's lifetime, and because the base an
 * operator already has to point at Redis for revocation to work across instances
 * is the base a replay guard has to share for the same reason. A `cache` entry
 * can be evicted under pressure; a replay guard that can be evicted is not one.
 */
export function useWsTicketStore(): Storage<BurnedTicket> {
  return useStorage<BurnedTicket>(SESSIONS_BASE)
}

/** `ws-ticket:<jti>`, encoded so a `jti` cannot forge a key in another namespace. */
export function burnedTicketKey(ticketId: string): string {
  return `${BURNED_TICKET_PREFIX}:${encodeURIComponent(ticketId)}`
}

/**
 * The outcome of trying to spend a ticket.
 *
 *  - `fresh` — nothing had recorded this `jti`; the handshake may proceed.
 *  - `replayed` — it had been spent. The handshake must not proceed.
 *  - `unchecked` — the store could not answer. See the fail-open note below.
 */
export type TicketBurn = 'fresh' | 'replayed' | 'unchecked'

/**
 * Records a ticket as spent, reporting whether it already was.
 *
 * ## Two honest limitations
 *
 * **This is not atomic.** `unstorage` has no compare-and-set, so two upgrades
 * presenting the same ticket within the same event-loop turn can both read a
 * miss and both proceed. What this closes is the *reuse* window — a ticket
 * captured from a log or a referrer and replayed later — not a race between two
 * simultaneous handshakes. Closing that one needs a driver-level `SET NX`, which
 * `unstorage` does not expose; the cost of leaving it open is bounded by the
 * ticket's lifetime and by the fact that both connections would belong to the
 * same user anyway.
 *
 * **It fails open.** A store that is unreachable returns `unchecked` and the
 * handshake continues, which is the same trade `session-store.ts` documents at
 * length: fail-closed would make Redis a hard dependency of connecting, so a
 * Redis blip would take WebSockets down entirely rather than degrade them. What
 * fail-open costs here is exactly the replay window the ticket's TTL already
 * defines — 30 seconds — because the signature, the audience and the expiry are
 * all still checked. The caller logs it; `docs/websockets.md` says so next to the
 * deployment checklist.
 */
export async function burnTicket(
  store: Storage<BurnedTicket>,
  claims: WsTicketClaims,
  now: number = Date.now(),
): Promise<TicketBurn> {
  const key = burnedTicketKey(claims.ticketId)

  try {
    if (await store.hasItem(key)) return 'replayed'

    // The record only has to outlive the ticket. Rounding up by a second covers
    // the `Math.floor` in `mintWsTicket`, and the clock tolerance covers a peer
    // whose clock runs behind ours — without both, a ticket could become
    // replayable in the last moments it is still valid.
    const ttlSeconds =
      Math.ceil(Math.max(0, claims.expiresAt - now) / 1000) + TICKET_CLOCK_TOLERANCE_SECONDS + 1

    await store.setItem(key, { userId: claims.userId, burnedAt: now }, { ttl: ttlSeconds })
    return 'fresh'
  } catch (error) {
    console.error('[ws] ticket store unreachable, replay unchecked:', error)
    return 'unchecked'
  }
}
