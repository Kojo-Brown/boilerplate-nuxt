import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'

import { describe, it, expect } from 'vitest'

import {
  CSRF_ORIGIN_ONLY_PATHS,
  classifyRequestSite,
  clampCsrfTtl,
  csrfTokenNeedsRefresh,
  csrfTokenRequired,
  decideCsrf,
  inspectCsrfToken,
  mintCsrfToken,
  parseCsrfOrigins,
  tokensMatch,
  DEFAULT_CSRF_TTL_SECONDS,
  MAX_CSRF_TTL_SECONDS,
  MIN_CSRF_TTL_SECONDS,
  type CsrfTokenState,
  type RequestSite,
} from '~/server/utils/csrf'
import { deriveCsrfKey } from '~/server/utils/csrf-config'
import { SAFE_METHODS, isStateChangingMethod } from '~/types/csrf'

/**
 * The CSRF decision, exercised as the pure function it is.
 *
 * No event, no Nitro, no server: `server/utils/csrf.ts` takes a key and a bag of
 * header values and returns a verdict, which is the whole reason it is separate
 * from `server/middleware/20.csrf.ts`. The middleware's own test covers what it
 * reads off a request and what it writes back; everything about *whether a
 * request is forged* is decided here.
 */

/**
 * Real derived keys, not stubs — the signature is the thing under test. Both
 * secrets are obviously fake and are 40 characters, because the derivation
 * refuses anything under 32.
 */
const key = await deriveCsrfKey('test-only-session-password-not-a-secret!!')

/** A second key, standing in for a different deployment or a rotated secret. */
const otherKey = await deriveCsrfKey('a-different-test-only-password-32-chars++')

const NOW = Date.UTC(2026, 0, 1, 12, 0, 0)

function signals(overrides: Partial<Parameters<typeof classifyRequestSite>[0]> = {}) {
  return {
    secFetchSite: undefined,
    origin: undefined,
    host: 'app.test',
    allowedOrigins: [] as readonly string[],
    ...overrides,
  }
}

describe('isStateChangingMethod', () => {
  it.each([...SAFE_METHODS])('treats %s as safe', (method) => {
    expect(isStateChangingMethod(method)).toBe(false)
  })

  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])('treats %s as state-changing', (method) => {
    expect(isStateChangingMethod(method)).toBe(true)
  })

  it('is case-insensitive, because a method is not required to arrive upper-case', () => {
    expect(isStateChangingMethod('post')).toBe(true)
    expect(isStateChangingMethod('get')).toBe(false)
  })

  it('reads a missing method as GET, which is what a request with none does', () => {
    expect(isStateChangingMethod(undefined)).toBe(false)
  })
})

describe('classifyRequestSite', () => {
  it('accepts Sec-Fetch-Site: same-origin', () => {
    expect(classifyRequestSite(signals({ secFetchSite: 'same-origin' }))).toBe('same-origin')
  })

  it('accepts Sec-Fetch-Site: none, which is a request no page initiated', () => {
    expect(classifyRequestSite(signals({ secFetchSite: 'none' }))).toBe('same-origin')
  })

  it('rejects same-site, which is exactly what SameSite=Lax lets through', () => {
    const site = classifyRequestSite(
      signals({ secFetchSite: 'same-site', origin: 'https://evil.app.test' }),
    )
    expect(site).toBe('cross-origin')
  })

  it('rejects cross-site', () => {
    const site = classifyRequestSite(
      signals({ secFetchSite: 'cross-site', origin: 'https://evil.test' }),
    )
    expect(site).toBe('cross-origin')
  })

  it('lets the allowlist override a same-site verdict', () => {
    const site = classifyRequestSite(
      signals({
        secFetchSite: 'same-site',
        origin: 'https://admin.app.test',
        allowedOrigins: ['https://admin.app.test'],
      }),
    )
    expect(site).toBe('same-origin')
  })

  it('matches an allowlist entry on the full origin, so a scheme mismatch is not allowed', () => {
    const site = classifyRequestSite(
      signals({
        secFetchSite: 'cross-site',
        origin: 'http://admin.app.test',
        allowedOrigins: ['https://admin.app.test'],
      }),
    )
    expect(site).toBe('cross-origin')
  })

  it('falls through to Origin when Sec-Fetch-Site is a value it does not know', () => {
    const site = classifyRequestSite(
      signals({ secFetchSite: 'sideways', origin: 'https://app.test' }),
    )
    expect(site).toBe('same-origin')
  })

  it('compares Origin by host, so TLS terminated at a proxy still reads as same-origin', () => {
    // The page is on https; the request reaches this app as http on the same host.
    expect(classifyRequestSite(signals({ origin: 'https://app.test' }))).toBe('same-origin')
  })

  it('treats a different host on the same site as cross-origin', () => {
    expect(classifyRequestSite(signals({ origin: 'https://evil.app.test' }))).toBe('cross-origin')
  })

  it('includes the port in the host comparison', () => {
    expect(classifyRequestSite(signals({ origin: 'http://app.test:3001' }))).toBe('cross-origin')
    expect(
      classifyRequestSite(signals({ host: 'app.test:3001', origin: 'http://app.test:3001' })),
    ).toBe('same-origin')
  })

  it('rejects the opaque "null" origin rather than failing to parse it into an allow', () => {
    expect(classifyRequestSite(signals({ origin: 'null' }))).toBe('cross-origin')
  })

  it('reports "unknown" when neither header is present', () => {
    expect(classifyRequestSite(signals())).toBe('unknown')
    expect(classifyRequestSite(signals({ origin: '' }))).toBe('unknown')
  })

  it('does not accept an Origin just because the app has no Host to compare it with', () => {
    expect(classifyRequestSite(signals({ host: undefined, origin: 'https://app.test' }))).toBe(
      'cross-origin',
    )
  })
})

describe('parseCsrfOrigins', () => {
  it('splits a comma-separated environment value and trims it', () => {
    expect(parseCsrfOrigins(' https://a.test , https://b.test ')).toEqual([
      'https://a.test',
      'https://b.test',
    ])
  })

  it('accepts an array, which is what nuxt.config.ts would give', () => {
    expect(parseCsrfOrigins(['https://a.test'])).toEqual(['https://a.test'])
  })

  it('is empty for an unset value', () => {
    expect(parseCsrfOrigins(undefined)).toEqual([])
    expect(parseCsrfOrigins('')).toEqual([])
    expect(parseCsrfOrigins(',,')).toEqual([])
  })
})

describe('clampCsrfTtl', () => {
  it('keeps a value inside the range', () => {
    expect(clampCsrfTtl(3600)).toBe(3600)
  })

  it('floors and caps out-of-range values instead of rejecting them', () => {
    expect(clampCsrfTtl(1)).toBe(MIN_CSRF_TTL_SECONDS)
    expect(clampCsrfTtl(MAX_CSRF_TTL_SECONDS * 10)).toBe(MAX_CSRF_TTL_SECONDS)
  })

  it('accepts the string an environment variable degrades to', () => {
    expect(clampCsrfTtl('3600')).toBe(3600)
  })

  it('falls back to the default for anything unparseable', () => {
    expect(clampCsrfTtl(undefined)).toBe(DEFAULT_CSRF_TTL_SECONDS)
    expect(clampCsrfTtl('later')).toBe(DEFAULT_CSRF_TTL_SECONDS)
  })
})

describe('mintCsrfToken / inspectCsrfToken', () => {
  it('accepts a token it just minted', async () => {
    const token = await mintCsrfToken({ key, now: NOW })
    await expect(inspectCsrfToken(token, { key, now: NOW })).resolves.toEqual({
      status: 'valid',
      expiresAt: NOW + DEFAULT_CSRF_TTL_SECONDS * 1000,
    })
  })

  it('mints a different token every time, so a re-issue is visibly a new value', async () => {
    const first = await mintCsrfToken({ key, now: NOW })
    const second = await mintCsrfToken({ key, now: NOW })
    expect(first).not.toBe(second)
  })

  it('refuses a token signed with a different deployment key', async () => {
    const token = await mintCsrfToken({ key: otherKey, now: NOW })
    await expect(inspectCsrfToken(token, { key, now: NOW })).resolves.toEqual({ status: 'invalid' })
  })

  it('refuses a token whose expiry has been edited, because the expiry is signed', async () => {
    const token = await mintCsrfToken({ key, now: NOW, ttlSeconds: MIN_CSRF_TTL_SECONDS })
    const [salt, , mac] = token.split('.')
    const later = (Math.floor(NOW / 1000) + MAX_CSRF_TTL_SECONDS).toString(36)

    await expect(inspectCsrfToken(`${salt}.${later}.${mac}`, { key, now: NOW })).resolves.toEqual({
      status: 'invalid',
    })
  })

  it('refuses a token past its expiry', async () => {
    const token = await mintCsrfToken({ key, now: NOW, ttlSeconds: MIN_CSRF_TTL_SECONDS })
    const after = NOW + (MIN_CSRF_TTL_SECONDS + 1) * 1000

    await expect(inspectCsrfToken(token, { key, now: after })).resolves.toEqual({
      status: 'expired',
    })
  })

  it.each([
    ['nothing at all', undefined],
    ['an empty string', ''],
    ['too few fields', 'salt.expiry'],
    ['too many fields', 'salt.expiry.mac.extra'],
    ['an empty field', 'salt..mac'],
  ])('reports %s as malformed', async (_label, token) => {
    await expect(inspectCsrfToken(token, { key, now: NOW })).resolves.toEqual({
      status: 'malformed',
    })
  })

  it('clamps a wildly long requested lifetime rather than honouring it', async () => {
    const token = await mintCsrfToken({ key, now: NOW, ttlSeconds: MAX_CSRF_TTL_SECONDS * 100 })
    const state = await inspectCsrfToken(token, { key, now: NOW })

    expect(state.expiresAt).toBe(NOW + MAX_CSRF_TTL_SECONDS * 1000)
  })
})

describe('csrfTokenNeedsRefresh', () => {
  const ttl = 3600
  const valid = (expiresAt: number): CsrfTokenState => ({ status: 'valid', expiresAt })

  it('leaves a fresh token alone', () => {
    expect(csrfTokenNeedsRefresh(valid(NOW + ttl * 1000), ttl, NOW)).toBe(false)
  })

  it('replaces one that is past half its life', () => {
    expect(csrfTokenNeedsRefresh(valid(NOW + (ttl * 1000) / 2 - 1), ttl, NOW)).toBe(true)
  })

  it.each<CsrfTokenState>([{ status: 'malformed' }, { status: 'expired' }, { status: 'invalid' }])(
    'replaces a $status token',
    (state) => {
      expect(csrfTokenNeedsRefresh(state, ttl, NOW)).toBe(true)
    },
  )
})

describe('tokensMatch', () => {
  it('accepts two identical values', () => {
    expect(tokensMatch('abc', 'abc')).toBe(true)
  })

  it('rejects values of the same length that differ', () => {
    expect(tokensMatch('abc', 'abd')).toBe(false)
  })

  it('rejects values of different lengths without throwing', () => {
    expect(tokensMatch('abc', 'abcdef')).toBe(false)
  })

  it('rejects an absent or empty half', () => {
    expect(tokensMatch(undefined, 'abc')).toBe(false)
    expect(tokensMatch('abc', undefined)).toBe(false)
    expect(tokensMatch('', '')).toBe(false)
  })
})

describe('csrfTokenRequired', () => {
  it('requires a token everywhere by default', () => {
    expect(csrfTokenRequired('/api/todos')).toBe(true)
    expect(csrfTokenRequired('/api/auth/login')).toBe(true)
    expect(csrfTokenRequired('/')).toBe(true)
  })

  it('exempts the vitals ingest, which sendBeacon cannot add a header to', () => {
    expect(csrfTokenRequired('/api/vitals')).toBe(false)
  })

  it('does not let an exact exemption cover the routes below it', () => {
    expect(csrfTokenRequired('/api/vitals/summary')).toBe(true)
  })

  it('matches a wildcard exemption on the prefix and everything under it', () => {
    const rules = ['/api/demo/**']
    expect(csrfTokenRequired('/api/demo', rules)).toBe(false)
    expect(csrfTokenRequired('/api/demo/deep/path', rules)).toBe(false)
    expect(csrfTokenRequired('/api/demonstration', rules)).toBe(true)
  })

  it('every exemption still names a route that exists', async () => {
    // The same guard `tests/unit/server/access-policy.test.ts` puts on the
    // public carve-outs, for the same reason: an exemption that outlives its
    // endpoint is a hole nobody is looking at any more.
    //
    // `/api/_auth/session` is registered by `nuxt-auth-utils` rather than by a
    // file under `server/api/`, so it is resolved against the module list in
    // `nuxt.config.ts` instead — which is the thing that would actually change
    // if that route stopped existing.
    const routes = await apiRoutes()
    const nuxtConfig = await readFile(
      path.resolve(import.meta.dirname, '../../../nuxt.config.ts'),
      'utf8',
    )

    for (const pattern of CSRF_ORIGIN_ONLY_PATHS) {
      const prefix = pattern.endsWith('/**') ? pattern.slice(0, -3) : pattern

      const live = pattern.startsWith('/api/_auth/')
        ? nuxtConfig.includes(`'nuxt-auth-utils'`)
        : routes.some((route) => route === prefix || route.startsWith(`${prefix}/`))

      expect(live, `${pattern} exempts a route that no longer exists`).toBe(true)
    }
  })
})

describe('decideCsrf', () => {
  const base = {
    method: 'POST',
    site: 'same-origin' as RequestSite,
    tokenRequired: true,
    cookieToken: 'token',
    headerToken: 'token',
    cookieState: { status: 'valid', expiresAt: NOW + 1000 } as CsrfTokenState,
  }

  it('passes a same-origin write whose cookie and header agree', () => {
    expect(decideCsrf(base)).toEqual({ ok: true })
  })

  it('passes any safe method without looking at anything else', () => {
    expect(
      decideCsrf({
        ...base,
        method: 'GET',
        site: 'cross-origin',
        cookieToken: undefined,
        headerToken: undefined,
        cookieState: undefined,
      }),
    ).toEqual({ ok: true })
  })

  it('refuses a cross-origin write before it looks at a token', () => {
    expect(decideCsrf({ ...base, site: 'cross-origin' })).toEqual({
      ok: false,
      reason: 'cross-origin',
    })
  })

  it('refuses a write that carries no site signal at all', () => {
    expect(decideCsrf({ ...base, site: 'unknown' })).toEqual({ ok: false, reason: 'no-origin' })
  })

  it('passes an origin-only route on the site check alone', () => {
    expect(
      decideCsrf({
        ...base,
        tokenRequired: false,
        cookieToken: undefined,
        headerToken: undefined,
        cookieState: undefined,
      }),
    ).toEqual({ ok: true })
  })

  it('names the missing half', () => {
    expect(decideCsrf({ ...base, cookieToken: undefined })).toEqual({
      ok: false,
      reason: 'missing-cookie',
    })
    expect(decideCsrf({ ...base, headerToken: undefined })).toEqual({
      ok: false,
      reason: 'missing-header',
    })
  })

  it('reports why the cookie failed verification', () => {
    expect(decideCsrf({ ...base, cookieState: { status: 'expired' } })).toEqual({
      ok: false,
      reason: 'token-expired',
    })
    expect(decideCsrf({ ...base, cookieState: { status: 'invalid' } })).toEqual({
      ok: false,
      reason: 'token-invalid',
    })
  })

  it('refuses rather than passing when the caller never inspected the cookie', () => {
    expect(decideCsrf({ ...base, cookieState: undefined })).toEqual({
      ok: false,
      reason: 'token-invalid',
    })
  })

  it('refuses a header that does not equal the cookie, even when both verify', () => {
    // The attack this is the whole defence against: a page that can *guess* the
    // shape of a token but cannot read the one in the victim's cookie jar.
    expect(decideCsrf({ ...base, headerToken: 'a-different-token' })).toEqual({
      ok: false,
      reason: 'mismatched-token',
    })
  })
})

/** Every route path under `server/api/`, derived from the filesystem. */
async function apiRoutes(): Promise<string[]> {
  const root = path.resolve(import.meta.dirname, '../../../server/api')
  const found: string[] = []

  async function walk(directory: string, prefix: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const child = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        await walk(child, `${prefix}/${entry.name}`)
        continue
      }
      const name = entry.name.replace(/\.(get|post|put|patch|delete)?\.?ts$/, '')
      found.push(name === 'index' ? prefix : `${prefix}/${name}`)
    }
  }

  await walk(root, '/api')
  return found
}
