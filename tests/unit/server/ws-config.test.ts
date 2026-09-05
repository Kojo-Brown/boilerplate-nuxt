import { describe, it, expect, afterEach, vi } from 'vitest'

import { resolveWsConfig, resetWsConfigCache, useWsConfig } from '~/server/utils/ws-config'
import { deriveTicketKey, DEFAULT_TICKET_TTL_SECONDS } from '~/server/utils/ws-ticket'

/** Obviously fake, and 40 characters — the derivation refuses anything under 32. */
const SESSION_PASSWORD = 'test-only-session-password-not-a-secret!!'
const TICKET_SECRET = 'test-only-ticket-secret-not-a-secret-xxx!'

afterEach(() => {
  resetWsConfigCache()
  vi.unstubAllGlobals()
})

describe('resolveWsConfig', () => {
  it('derives the ticket key from the session password by default', async () => {
    const config = await resolveWsConfig({ session: { password: SESSION_PASSWORD } })
    expect(config.key).toEqual(await deriveTicketKey(SESSION_PASSWORD))
  })

  it('prefers an explicit ticket secret, so the two can rotate apart', async () => {
    const config = await resolveWsConfig({
      ws: { ticketSecret: TICKET_SECRET },
      session: { password: SESSION_PASSWORD },
    })

    expect(config.key).toEqual(await deriveTicketKey(TICKET_SECRET))
    expect(config.key).not.toEqual(await deriveTicketKey(SESSION_PASSWORD))
  })

  it('falls back when the ticket secret is present but blank', async () => {
    // `runtimeConfig.ws.ticketSecret` defaults to `''` in nuxt.config.ts, so the
    // empty string is the normal case, not an edge one.
    const config = await resolveWsConfig({
      ws: { ticketSecret: '   ' },
      session: { password: SESSION_PASSWORD },
    })
    expect(config.key).toEqual(await deriveTicketKey(SESSION_PASSWORD))
  })

  it('refuses to run with no secret at all rather than inventing one', async () => {
    await expect(resolveWsConfig({})).rejects.toThrow(/NUXT_SESSION_PASSWORD/)
    await expect(resolveWsConfig({ session: { password: '' } })).rejects.toThrow(/No secret/)
  })

  it('propagates the length requirement from the derivation', async () => {
    await expect(resolveWsConfig({ session: { password: 'too-short' } })).rejects.toThrow(
      /at least 32 characters/,
    )
  })

  it('clamps the configured TTL', async () => {
    const base = { session: { password: SESSION_PASSWORD } }

    expect((await resolveWsConfig(base)).ticketTtlSeconds).toBe(DEFAULT_TICKET_TTL_SECONDS)
    expect(
      (await resolveWsConfig({ ...base, ws: { ticketTtlSeconds: 99_999 } })).ticketTtlSeconds,
    ).toBe(300)
    // The string a NUXT_WS_TICKET_TTL_SECONDS override arrives as.
    expect(
      (await resolveWsConfig({ ...base, ws: { ticketTtlSeconds: '45' } })).ticketTtlSeconds,
    ).toBe(45)
  })

  it('parses the allowed-origin list', async () => {
    const config = await resolveWsConfig({
      session: { password: SESSION_PASSWORD },
      ws: { allowedOrigins: 'https://a.test, https://b.test' },
    })
    expect(config.allowedOrigins).toEqual(['https://a.test', 'https://b.test'])
  })
})

describe('useWsConfig', () => {
  function stubRuntimeConfig(value: unknown): void {
    // `useRuntimeConfig` is a Nitro auto-import; outside Nitro it is a global
    // that does not exist. Stubbing it is what lets the memo be tested at all.
    vi.stubGlobal('useRuntimeConfig', () => value)
  }

  it('derives once and hands the same config back', async () => {
    stubRuntimeConfig({ session: { password: SESSION_PASSWORD } })

    const first = await useWsConfig()
    const second = await useWsConfig()

    // Identity, not equality: a second derivation would produce an equal key and
    // a different object, and the point of the memo is that it does not happen.
    expect(second).toBe(first)
  })

  it('re-derives when the secret changes rather than serving a stale key', async () => {
    stubRuntimeConfig({ session: { password: SESSION_PASSWORD } })
    const first = await useWsConfig()

    stubRuntimeConfig({ session: { password: TICKET_SECRET } })
    const second = await useWsConfig()

    expect(second).not.toBe(first)
    expect(second.key).toEqual(await deriveTicketKey(TICKET_SECRET))
  })

  it('shares one derivation between two callers racing on a cold process', async () => {
    stubRuntimeConfig({ session: { password: SESSION_PASSWORD } })

    const [a, b] = await Promise.all([useWsConfig(), useWsConfig()])
    expect(a).toBe(b)
  })

  it('surfaces a misconfiguration as a rejection, not a silent default', async () => {
    stubRuntimeConfig({ session: { password: '' } })
    await expect(useWsConfig()).rejects.toThrow(/No secret/)
  })
})
