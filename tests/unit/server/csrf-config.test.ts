import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

import { mintCsrfToken, inspectCsrfToken, DEFAULT_CSRF_TTL_SECONDS } from '~/server/utils/csrf'
import {
  deriveCsrfKey,
  resolveCsrfConfig,
  resetCsrfConfigCache,
  useCsrfConfig,
} from '~/server/utils/csrf-config'
import { deriveTicketKey } from '~/server/utils/ws-ticket'

/**
 * The seam between `runtimeConfig` and the CSRF gate.
 *
 * Two things are worth asserting here and nothing else is: that the key is
 * derived from the session password rather than being it, and that the memo is
 * keyed on the secret — a cache that outlived a config change would authenticate
 * tokens against a key the deployment no longer uses.
 */

/** Obviously fake, and 40 characters: the derivation refuses anything under 32. */
const SECRET = 'test-only-session-password-not-a-secret!!'
const OTHER_SECRET = 'a-different-test-only-password-32-chars++'

beforeEach(() => {
  resetCsrfConfigCache()
})

afterEach(() => {
  resetCsrfConfigCache()
  vi.unstubAllGlobals()
})

describe('deriveCsrfKey', () => {
  it('refuses a secret too short to be a seal key', async () => {
    await expect(deriveCsrfKey('short')).rejects.toThrow(/at least 32 characters/)
    await expect(deriveCsrfKey('')).rejects.toThrow(/NUXT_SESSION_PASSWORD/)
  })

  it('is deterministic, so two instances verify tokens minted by the other', async () => {
    const [left, right] = await Promise.all([deriveCsrfKey(SECRET), deriveCsrfKey(SECRET)])
    const token = await mintCsrfToken({ key: left })

    await expect(inspectCsrfToken(token, { key: right })).resolves.toMatchObject({
      status: 'valid',
    })
  })

  it('is not the WebSocket ticket key, though both come from the same password', async () => {
    // HKDF with a different `info` string. If the two ever collided, a ticket
    // signature would be a forgery oracle for a CSRF token and vice versa.
    //
    // Asserted by signing rather than by comparing the key material, because
    // `deriveCsrfKey` deliberately returns a non-extractable key — which is the
    // next assertion.
    const csrf = await deriveCsrfKey(SECRET)
    const ticket = await crypto.subtle.importKey(
      'raw',
      // Copied into a fresh buffer: `deriveTicketKey` returns a view whose
      // backing buffer TypeScript will not narrow to `ArrayBuffer`.
      new Uint8Array(await deriveTicketKey(SECRET)),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    )
    const message = new TextEncoder().encode('the same message, under two keys')

    const [fromCsrf, fromTicket] = await Promise.all([
      crypto.subtle.sign('HMAC', csrf, message),
      crypto.subtle.sign('HMAC', ticket, message),
    ])

    expect([...new Uint8Array(fromCsrf)]).not.toEqual([...new Uint8Array(fromTicket)])
  })

  it('produces a key that can sign and cannot be read back out', async () => {
    const csrf = await deriveCsrfKey(SECRET)

    expect(csrf.extractable).toBe(false)
    expect(csrf.usages).toEqual(['sign'])
    await expect(crypto.subtle.exportKey('raw', csrf)).rejects.toThrow()
  })
})

describe('resolveCsrfConfig', () => {
  it('reads the TTL and the allowlist, clamping the first', async () => {
    const config = await resolveCsrfConfig({
      session: { password: SECRET },
      security: { csrf: { tokenTtlSeconds: 1, allowedOrigins: 'https://admin.app.test' } },
    })

    expect(config.ttlSeconds).toBe(300)
    expect(config.allowedOrigins).toEqual(['https://admin.app.test'])
  })

  it('defaults to a twelve-hour token and no extra origins', async () => {
    const config = await resolveCsrfConfig({ session: { password: SECRET } })

    expect(config.ttlSeconds).toBe(DEFAULT_CSRF_TTL_SECONDS)
    expect(config.allowedOrigins).toEqual([])
  })

  it('fails on a deployment with no seal key rather than signing with nothing', async () => {
    await expect(resolveCsrfConfig({})).rejects.toThrow(/session.password/)
  })
})

describe('useCsrfConfig', () => {
  it('derives once for the same secret', async () => {
    let calls = 0
    vi.stubGlobal('useRuntimeConfig', () => {
      calls++
      return { session: { password: SECRET } }
    })

    const [first, second] = await Promise.all([useCsrfConfig(), useCsrfConfig()])

    expect(first).toBe(second)
    expect(calls).toBe(2)
  })

  it('derives again when the secret changes', async () => {
    let password = SECRET
    vi.stubGlobal('useRuntimeConfig', () => ({ session: { password } }))

    const first = await useCsrfConfig()
    password = OTHER_SECRET
    const second = await useCsrfConfig()

    expect(first).not.toBe(second)

    // And the new key really is a different one: a token minted under the old
    // config no longer verifies.
    const stale = await mintCsrfToken({ key: first.key })
    await expect(inspectCsrfToken(stale, { key: second.key })).resolves.toEqual({
      status: 'invalid',
    })
  })
})
