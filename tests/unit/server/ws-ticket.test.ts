import { SignJWT, decodeProtectedHeader, decodeJwt } from 'jose'
import { createStorage, type Storage } from 'unstorage'
import memoryDriver from 'unstorage/drivers/memory'
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'

import {
  burnTicket,
  burnedTicketKey,
  clampTicketTtl,
  deriveTicketKey,
  mintWsTicket,
  verifyWsTicket,
  DEFAULT_TICKET_TTL_SECONDS,
  MAX_TICKET_TTL_SECONDS,
  TICKET_CLOCK_TOLERANCE_SECONDS,
  WS_TICKET_ALG,
  WS_TICKET_ISSUER,
  WS_TICKET_TYP,
  type BurnedTicket,
} from '~/server/utils/ws-ticket'

/**
 * The tickets are signed with a real key derived by the real HKDF and verified
 * by the real `jose` — nothing here is stubbed, because every claim this module
 * makes is a claim about cryptography or about the JWT specification, and a mock
 * of either would agree with whatever the test expected.
 *
 * Obviously fake secrets. `SECRET` is 40 characters because the derivation
 * refuses anything under 32, which is itself one of the assertions below.
 */
const SECRET = 'test-only-session-password-not-a-secret!!'
const OTHER_SECRET = 'a-different-test-only-password-32-chars++'
const NOW = 1_800_000_000_000

let key: Uint8Array
let otherKey: Uint8Array

beforeEach(async () => {
  key = await deriveTicketKey(SECRET)
  otherKey = await deriveTicketKey(OTHER_SECRET)
})

function mint(overrides: Partial<Parameters<typeof mintWsTicket>[0]> = {}) {
  return mintWsTicket({
    key,
    userId: 'user-1',
    sessionId: 'sess-1',
    channel: 'echo',
    now: NOW,
    ticketId: 'ticket-1',
    ...overrides,
  })
}

describe('deriveTicketKey', () => {
  it('is deterministic, so any instance can verify any instance’s ticket', async () => {
    expect(await deriveTicketKey(SECRET)).toEqual(await deriveTicketKey(SECRET))
  })

  it('produces a 256-bit key', async () => {
    expect(key).toHaveLength(32)
  })

  it('is not the secret itself — that is the whole point of deriving it', () => {
    expect(new TextDecoder().decode(key)).not.toContain('session-password')
    expect(key).not.toEqual(new TextEncoder().encode(SECRET).slice(0, 32))
  })

  it('separates keys derived from different secrets', async () => {
    expect(key).not.toEqual(otherKey)
  })

  it('refuses a secret too short to be one', async () => {
    await expect(deriveTicketKey('short')).rejects.toThrow(/at least 32 characters/)
  })
})

describe('clampTicketTtl', () => {
  it('defaults when the value is absent or unparseable', () => {
    expect(clampTicketTtl(undefined)).toBe(DEFAULT_TICKET_TTL_SECONDS)
    expect(clampTicketTtl('not a number')).toBe(DEFAULT_TICKET_TTL_SECONDS)
  })

  it('accepts the string a NUXT_* environment override arrives as', () => {
    // `runtimeConfig` values overridden by env vars are strings unless Nuxt's
    // coercion recognises the default's type — the same trap `storage.ts`
    // documents for NUXT_REDIS_CACHE_TTL.
    expect(clampTicketTtl('45')).toBe(45)
  })

  it('clamps to the supported range rather than trusting configuration', () => {
    expect(clampTicketTtl(0)).toBe(1)
    expect(clampTicketTtl(-30)).toBe(1)
    expect(clampTicketTtl(MAX_TICKET_TTL_SECONDS + 1)).toBe(MAX_TICKET_TTL_SECONDS)
  })
})

describe('mintWsTicket', () => {
  it('pins the algorithm and the media type in the protected header', async () => {
    const { token } = await mint()
    expect(decodeProtectedHeader(token)).toMatchObject({
      alg: WS_TICKET_ALG,
      typ: WS_TICKET_TYP,
    })
  })

  it('carries the identity in standard claims, not bespoke ones', async () => {
    const { token } = await mint()
    const payload = decodeJwt(token)

    expect(payload).toMatchObject({
      iss: WS_TICKET_ISSUER,
      aud: 'echo',
      sub: 'user-1',
      jti: 'ticket-1',
      sid: 'sess-1',
    })
  })

  it('reports timestamps in milliseconds while signing them in seconds', async () => {
    // The unit mix is the bug this guards: `exp` is seconds by specification and
    // everything else in this codebase is milliseconds, so an expiry that was
    // 1000× too far away would look right in both places on its own.
    const { token, claims } = await mint()
    const payload = decodeJwt(token)

    expect(payload.exp).toBe(Math.floor(NOW / 1000) + DEFAULT_TICKET_TTL_SECONDS)
    expect(claims.expiresAt).toBe(NOW + DEFAULT_TICKET_TTL_SECONDS * 1000)
    expect(claims.issuedAt).toBe(NOW)
  })

  it('clamps a TTL longer than a ticket is allowed to live', async () => {
    const { claims } = await mint({ ttlSeconds: 60 * 60 })
    expect(claims.expiresAt - claims.issuedAt).toBe(MAX_TICKET_TTL_SECONDS * 1000)
  })

  it('mints a distinct jti per ticket when one is not supplied', async () => {
    const a = await mintWsTicket({ key, userId: 'u', sessionId: 's', channel: 'echo', now: NOW })
    const b = await mintWsTicket({ key, userId: 'u', sessionId: 's', channel: 'echo', now: NOW })
    expect(a.claims.ticketId).not.toBe(b.claims.ticketId)
  })
})

describe('verifyWsTicket', () => {
  it('round-trips the claims it was minted with', async () => {
    const { token, claims } = await mint()
    const result = await verifyWsTicket(token, { key, channel: 'echo', now: NOW })

    expect(result).toEqual({ ok: true, claims })
  })

  it('rejects a ticket signed with another key', async () => {
    const { token } = await mint({ key: otherKey })
    await expect(verifyWsTicket(token, { key, channel: 'echo', now: NOW })).resolves.toEqual({
      ok: false,
      reason: 'bad-signature',
    })
  })

  it('rejects a ticket minted for another channel', async () => {
    // `aud` is the claim that stops a ticket for one channel opening another.
    // The channel union has one member today, so the ticket is built by hand —
    // which is also how a client would try it.
    const token = await new SignJWT({ sid: 'sess-1' })
      .setProtectedHeader({ alg: WS_TICKET_ALG, typ: WS_TICKET_TYP })
      .setIssuer(WS_TICKET_ISSUER)
      .setAudience('chat')
      .setSubject('user-1')
      .setJti('ticket-1')
      .setIssuedAt(Math.floor(NOW / 1000))
      .setExpirationTime(Math.floor(NOW / 1000) + 30)
      .sign(key)

    await expect(verifyWsTicket(token, { key, channel: 'echo', now: NOW })).resolves.toEqual({
      ok: false,
      reason: 'wrong-channel',
    })
  })

  it('rejects a ticket from another issuer holding the same key', async () => {
    const token = await new SignJWT({ sid: 'sess-1' })
      .setProtectedHeader({ alg: WS_TICKET_ALG, typ: WS_TICKET_TYP })
      .setIssuer('somebody-else')
      .setAudience('echo')
      .setSubject('user-1')
      .setJti('t')
      .setIssuedAt(Math.floor(NOW / 1000))
      .setExpirationTime(Math.floor(NOW / 1000) + 30)
      .sign(key)

    await expect(verifyWsTicket(token, { key, channel: 'echo', now: NOW })).resolves.toEqual({
      ok: false,
      reason: 'wrong-issuer',
    })
  })

  it('rejects a token that is not a ticket even when the signature is ours', async () => {
    // The `typ` check is what stops another credential signed with the same key
    // being spent as a handshake ticket — RFC 8725's explicit typing, and the
    // reason `WS_TICKET_TYP` exists rather than plain `JWT`.
    const token = await new SignJWT({ sid: 'sess-1' })
      .setProtectedHeader({ alg: WS_TICKET_ALG, typ: 'JWT' })
      .setIssuer(WS_TICKET_ISSUER)
      .setAudience('echo')
      .setSubject('user-1')
      .setJti('t')
      .setIssuedAt(Math.floor(NOW / 1000))
      .setExpirationTime(Math.floor(NOW / 1000) + 30)
      .sign(key)

    await expect(verifyWsTicket(token, { key, channel: 'echo', now: NOW })).resolves.toEqual({
      ok: false,
      reason: 'incomplete-claims',
    })
  })

  it('rejects an unsigned token', async () => {
    // The `alg: none` classic. `jose` refuses it, and pinning `algorithms`
    // means it stays refused if `jose` ever stops.
    const unsigned = `${Buffer.from(JSON.stringify({ alg: 'none', typ: WS_TICKET_TYP })).toString(
      'base64url',
    )}.${Buffer.from(
      JSON.stringify({ iss: WS_TICKET_ISSUER, aud: 'echo', sub: 'user-1' }),
    ).toString('base64url')}.`

    const result = await verifyWsTicket(unsigned, { key, channel: 'echo', now: NOW })
    expect(result.ok).toBe(false)
  })

  it('rejects a ticket that has expired', async () => {
    const { token, claims } = await mint()
    const past = claims.expiresAt + (TICKET_CLOCK_TOLERANCE_SECONDS + 1) * 1000

    await expect(verifyWsTicket(token, { key, channel: 'echo', now: past })).resolves.toEqual({
      ok: false,
      reason: 'expired',
    })
  })

  it('tolerates a few seconds of clock skew either side', async () => {
    const { token, claims } = await mint()
    const justPast = claims.expiresAt + (TICKET_CLOCK_TOLERANCE_SECONDS - 1) * 1000

    await expect(
      verifyWsTicket(token, { key, channel: 'echo', now: justPast }),
    ).resolves.toMatchObject({
      ok: true,
    })
  })

  it('rejects a ticket whose nbf has not arrived', async () => {
    const { token, claims } = await mint()
    const beforeIssue = claims.issuedAt - (TICKET_CLOCK_TOLERANCE_SECONDS + 2) * 1000

    await expect(
      verifyWsTicket(token, { key, channel: 'echo', now: beforeIssue }),
    ).resolves.toEqual({
      ok: false,
      reason: 'not-yet-valid',
    })
  })

  it('rejects a ticket with no session to revoke', async () => {
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: WS_TICKET_ALG, typ: WS_TICKET_TYP })
      .setIssuer(WS_TICKET_ISSUER)
      .setAudience('echo')
      .setSubject('user-1')
      .setJti('t')
      .setIssuedAt(Math.floor(NOW / 1000))
      .setExpirationTime(Math.floor(NOW / 1000) + 30)
      .sign(key)

    await expect(verifyWsTicket(token, { key, channel: 'echo', now: NOW })).resolves.toEqual({
      ok: false,
      reason: 'incomplete-claims',
    })
  })

  it.each<[string, Record<string, unknown>]>([
    ['a non-string sub', { sub: 42 }],
    ['a blank sid', { sid: '' }],
    ['a sid that is not a string', { sid: { id: 'sess-1' } }],
  ])('rejects %s, which jose would hand back as a valid token', async (_label, overrides) => {
    // `jwtVerify` checks the signature and the registered claims; it does not
    // know that `sid` is this app's and must be a non-empty string. Without the
    // guard these verify, and the socket opens with a session id nothing can
    // revoke.
    // `sub` is set through the payload rather than `setSubject`, which coerces
    // it to a string and would defeat the case being tested.
    const token = await new SignJWT({ sub: 'user-1', sid: 'sess-1', ...overrides })
      .setProtectedHeader({ alg: WS_TICKET_ALG, typ: WS_TICKET_TYP })
      .setIssuer(WS_TICKET_ISSUER)
      .setAudience('echo')
      .setJti('t')
      .setIssuedAt(Math.floor(NOW / 1000))
      .setExpirationTime(Math.floor(NOW / 1000) + 30)
      .sign(key)

    await expect(verifyWsTicket(token, { key, channel: 'echo', now: NOW })).resolves.toEqual({
      ok: false,
      reason: 'incomplete-claims',
    })
  })

  it.each([
    ['empty', ''],
    ['not a JWT at all', 'hello'],
    ['two segments', 'a.b'],
    ['a truncated signature', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.zzzz'],
  ])('returns a reason rather than throwing on %s', async (_label, token) => {
    // Everything on this path runs inside a crossws `upgrade` hook, where an
    // uncaught throw rejects the socket with no response at all.
    const result = await verifyWsTicket(token, { key, channel: 'echo', now: NOW })
    expect(result.ok).toBe(false)
  })

  it('never reports a reason to a caller that could tell one failure from another', async () => {
    // Not an assertion about this function — it is the handshake that must map
    // every reason onto one status. Pinned here because the reasons are the
    // input to that mapping, and a new one must not arrive unnoticed.
    const { token } = await mint()
    const expired = await verifyWsTicket(token, { key, channel: 'echo', now: NOW + 10 ** 7 })
    const forged = await verifyWsTicket(token, { key: otherKey, channel: 'echo', now: NOW })

    expect(expired.ok).toBe(false)
    expect(forged.ok).toBe(false)
    expect(expired).not.toEqual(forged)
  })
})

describe('burnTicket', () => {
  let store: Storage<BurnedTicket>

  beforeEach(() => {
    store = createStorage<BurnedTicket>({ driver: memoryDriver() })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('spends a ticket once and refuses the replay', async () => {
    const { claims } = await mint()

    expect(await burnTicket(store, claims, NOW)).toBe('fresh')
    expect(await burnTicket(store, claims, NOW + 100)).toBe('replayed')
  })

  it('keeps two tickets independent', async () => {
    const a = await mint({ ticketId: 'ticket-a' })
    const b = await mint({ ticketId: 'ticket-b' })

    expect(await burnTicket(store, a.claims, NOW)).toBe('fresh')
    expect(await burnTicket(store, b.claims, NOW)).toBe('fresh')
  })

  it('encodes the jti so one ticket id cannot forge another key', () => {
    expect(burnedTicketKey('a:b')).not.toBe(burnedTicketKey('a').concat(':b'))
    expect(burnedTicketKey('../escape')).not.toContain('/')
  })

  it('sets a TTL that outlives the ticket, never one that expires first', async () => {
    const setItem = vi.spyOn(store, 'setItem')
    const { claims } = await mint()

    await burnTicket(store, claims, NOW)

    const ttl = setItem.mock.calls[0]?.[2]?.ttl as number
    // A record that expired while the ticket was still valid would make the
    // ticket replayable in its final moments — the one window this guard exists
    // to close.
    expect(ttl * 1000).toBeGreaterThan(claims.expiresAt - NOW)
  })

  it('fails open when the store cannot answer, and says so', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(store, 'hasItem').mockRejectedValue(new Error('ECONNREFUSED'))
    const { claims } = await mint()

    // Fail-open is the documented trade: a Redis blip must degrade the replay
    // guard, not stop people connecting. The caller is told, so it can log it.
    expect(await burnTicket(store, claims, NOW)).toBe('unchecked')
    expect(consoleError).toHaveBeenCalled()
  })
})
