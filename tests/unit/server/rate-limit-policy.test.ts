import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, it, expect } from 'vitest'

import {
  normaliseAddress,
  rateLimitIdentity,
  rateLimitRules,
  rateLimitStoreKey,
  resolveClientIp,
  resolveRateLimitPolicy,
} from '~/server/utils/rate-limit-policy'
import { normalisePathname } from '~/server/utils/request-path'
import { MAX_WINDOW_SECONDS, MIN_LIMIT } from '~/server/utils/rate-limit'

const SERVER_DIR = fileURLToPath(new URL('../../../server', import.meta.url))

/**
 * The policy table, and who a request is counted against.
 *
 * The identity half is where the security of this feature actually sits: a
 * limiter keyed on something the caller can choose is a limiter that does
 * nothing, so {@link resolveClientIp} gets the spoofing cases in full.
 */

describe('resolveRateLimitPolicy', () => {
  it('does not limit page, payload or asset traffic', () => {
    for (const path of ['/', '/login', '/dashboard', '/_nuxt/entry.js', '/favicon.ico']) {
      expect(resolveRateLimitPolicy(path)).toBeNull()
    }
  })

  it('gives every API route a limit by default', () => {
    const match = resolveRateLimitPolicy('/api/todos')

    expect(match?.rule).toBe('/api/**')
    expect(match?.policy).toEqual({ limit: 300, windowSeconds: 60 })
  })

  it('limits login far more tightly than the API default', () => {
    const login = resolveRateLimitPolicy('/api/auth/login')
    const fallback = resolveRateLimitPolicy('/api/todos')

    expect(login?.rule).toBe('/api/auth/login')
    expect(login?.policy).toEqual({ limit: 5, windowSeconds: 300 })
    // The property that matters is the rate, not just the count: credential
    // stuffing is bounded by requests per second, and this has to be far below
    // the default for the limit to be worth having.
    const loginRate = login!.policy.limit / login!.policy.windowSeconds
    const defaultRate = fallback!.policy.limit / fallback!.policy.windowSeconds
    expect(loginRate).toBeLessThan(defaultRate / 100)
  })

  it.each([
    { path: '/api/auth/logout', rule: '/api/auth/**' },
    { path: '/api/auth/csrf', rule: '/api/auth/csrf' },
    { path: '/api/vitals', rule: '/api/vitals' },
    { path: '/api/uploads/presign', rule: '/api/uploads/presign' },
    { path: '/api/cached/invalidate', rule: '/api/cached/invalidate' },
    { path: '/api/ws/ticket', rule: '/api/ws/ticket' },
  ])('resolves $path through the most specific rule, $rule', ({ path, rule }) => {
    expect(resolveRateLimitPolicy(path)?.rule).toBe(rule)
  })

  it('leaves the vitals summary on the API default rather than the ingest carve-out', () => {
    // `/api/vitals` is an exact key precisely so it does not cover the read
    // endpoint below it, which is authenticated and much cheaper to serve.
    expect(resolveRateLimitPolicy('/api/vitals/summary')?.rule).toBe('/api/**')
  })

  it('matches a normalised path, so a traversal cannot buy a looser bucket', () => {
    // The same bypass `access-policy.ts` guards against, with a milder
    // consequence: the wrong bucket rather than an open endpoint. Both are the
    // result of matching a raw path, so both are tested.
    for (const raw of [
      '/api/auth/login',
      '/api/auth/login/',
      '//api//auth//login',
      '/api/auth/login?next=/',
      '/api/todos/%2e%2e/auth/login',
      '/api/todos/%252e%252e/auth/login',
    ]) {
      expect(resolveRateLimitPolicy(normalisePathname(raw))?.rule).toBe('/api/auth/login')
    }
  })

  it('clamps a table entry, so a typo cannot mean "no limit"', () => {
    const match = resolveRateLimitPolicy('/api/thing', {
      '/api/**': { limit: 0, windowSeconds: MAX_WINDOW_SECONDS * 10 },
    })

    expect(match?.policy).toEqual({ limit: MIN_LIMIT, windowSeconds: MAX_WINDOW_SECONDS })
  })

  it('returns null for a table with no matching rule', () => {
    expect(
      resolveRateLimitPolicy('/api/todos', { '/api/auth/**': { limit: 5, windowSeconds: 60 } }),
    ).toBeNull()
  })
})

describe('the policy table itself', () => {
  /**
   * Every exact key has to name a route that exists, or the limit is protecting
   * nothing and the next reader has to work out whether that is deliberate. Same
   * check, and the same reason, as the carve-out test in
   * `tests/unit/server/access-policy.test.ts`.
   */
  it('has no exact key naming a route that no longer exists', () => {
    const exactKeys = Object.keys(rateLimitRules).filter((key) => !key.endsWith('/**'))

    expect(exactKeys.length).toBeGreaterThan(0)

    for (const key of exactKeys) {
      const base = `${SERVER_DIR}${key === '/api/vitals' ? '/api/vitals/index' : key}`
      const exists = ['get', 'post', 'put', 'patch', 'delete'].some((method) =>
        existsSync(`${base}.${method}.ts`),
      )

      expect(exists, `${key} has a rate limit but no handler under server/`).toBe(true)
    }
  })

  it('carries a catch-all, so an unmatched path is a decision and not an accident', () => {
    expect(rateLimitRules['/**']).toBeNull()
  })

  it('limits every /api route, including ones with no key of their own', () => {
    for (const path of ['/api/todos', '/api/posts', '/api/metrics', '/api/uploads']) {
      expect(resolveRateLimitPolicy(path)).not.toBeNull()
    }
  })
})

describe('normaliseAddress', () => {
  it.each([
    { input: '::ffff:127.0.0.1', expected: '127.0.0.1' },
    { input: '1.2.3.4', expected: '1.2.3.4' },
    { input: '  1.2.3.4  ', expected: '1.2.3.4' },
    { input: '2001:DB8::1', expected: '2001:db8::1' },
    { input: '[2001:db8::1]:443', expected: '2001:db8::1' },
    { input: '[2001:db8::1]', expected: '2001:db8::1' },
    { input: '1.2.3.4:443', expected: '1.2.3.4' },
  ])('normalises $input to $expected', ({ input, expected }) => {
    expect(normaliseAddress(input)).toBe(expected)
  })

  it('does not mistake an IPv6 group for a port', () => {
    // The reason only the bracketed form is split: an unbracketed IPv6 address is
    // full of colons, so stripping "the bit after the last colon" would corrupt it.
    expect(normaliseAddress('2001:db8::8a2e:370:7334')).toBe('2001:db8::8a2e:370:7334')
  })

  it('puts a dual-stack socket and a proxy entry in the same bucket', () => {
    expect(normaliseAddress('::ffff:203.0.113.7')).toBe(normaliseAddress('203.0.113.7'))
  })
})

describe('resolveClientIp', () => {
  it('ignores x-forwarded-for entirely when no proxy is trusted', () => {
    // The default, and the whole reason it is the default: a caller cannot choose
    // their own bucket.
    expect(
      resolveClientIp({
        forwardedFor: '9.9.9.9',
        socketAddress: '10.0.0.1',
        trustProxyHops: 0,
      }),
    ).toBe('10.0.0.1')
  })

  it('takes the entry the nearest trusted proxy wrote, not the one the client sent', () => {
    // A client hoping for a fresh bucket sends `x-forwarded-for: 9.9.9.9`; the
    // load balancer appends their real address. Counting from the right reads the
    // balancer's entry. Counting from the left — which is what h3's
    // `getRequestIP({ xForwardedFor: true })` does — would read the spoof.
    expect(
      resolveClientIp({
        forwardedFor: '9.9.9.9, 203.0.113.7',
        socketAddress: '10.0.0.1',
        trustProxyHops: 1,
      }),
    ).toBe('203.0.113.7')
  })

  it('reads a single-entry chain behind one proxy', () => {
    expect(
      resolveClientIp({
        forwardedFor: '203.0.113.7',
        socketAddress: '10.0.0.1',
        trustProxyHops: 1,
      }),
    ).toBe('203.0.113.7')
  })

  it('counts two hops for a CDN in front of a load balancer', () => {
    expect(
      resolveClientIp({
        forwardedFor: '203.0.113.7, 198.51.100.9',
        socketAddress: '10.0.0.1',
        trustProxyHops: 2,
      }),
    ).toBe('203.0.113.7')
  })

  it('does not let extra spoofed entries shift which hop is read', () => {
    // Two hops configured, and the client pads the header with three fakes. The
    // second-from-right is still the CDN's entry.
    expect(
      resolveClientIp({
        forwardedFor: '1.1.1.1, 2.2.2.2, 3.3.3.3, 203.0.113.7, 198.51.100.9',
        socketAddress: '10.0.0.1',
        trustProxyHops: 2,
      }),
    ).toBe('203.0.113.7')
  })

  it('falls back to the socket when the chain is shorter than the hop count', () => {
    // A misconfigured hop count, or a request that reached the app without going
    // through the proxy. The socket is the only value that is certainly true.
    expect(
      resolveClientIp({
        forwardedFor: '203.0.113.7',
        socketAddress: '10.0.0.1',
        trustProxyHops: 3,
      }),
    ).toBe('10.0.0.1')
  })

  it('falls back to the socket when the header is absent', () => {
    expect(
      resolveClientIp({ forwardedFor: undefined, socketAddress: '10.0.0.1', trustProxyHops: 1 }),
    ).toBe('10.0.0.1')
  })

  it.each([
    'not-an-address',
    'localhost',
    '1.2.3.4 OR 1=1',
    'a:b:c\nx-injected: yes',
    '../../etc/passwd',
  ])('refuses %j as an address and falls back to the socket', (spoofed) => {
    // An entry from this header becomes part of a storage key and a log line, so
    // it is whitelisted rather than trusted.
    expect(
      resolveClientIp({ forwardedFor: spoofed, socketAddress: '10.0.0.1', trustProxyHops: 1 }),
    ).toBe('10.0.0.1')
  })

  it('tolerates whitespace and empty entries in the chain', () => {
    expect(
      resolveClientIp({
        forwardedFor: ' 9.9.9.9 , , 203.0.113.7 ',
        socketAddress: '10.0.0.1',
        trustProxyHops: 1,
      }),
    ).toBe('203.0.113.7')
  })

  it('returns null when neither the header nor the socket yields anything usable', () => {
    expect(
      resolveClientIp({ forwardedFor: undefined, socketAddress: undefined, trustProxyHops: 0 }),
    ).toBeNull()
    expect(
      resolveClientIp({ forwardedFor: 'nonsense', socketAddress: 'nonsense', trustProxyHops: 1 }),
    ).toBeNull()
  })
})

describe('rateLimitIdentity', () => {
  it('prefers the user id, so a shared NAT does not throttle its occupants together', () => {
    expect(rateLimitIdentity({ userId: 'user-1', clientIp: '203.0.113.7' })).toEqual({
      kind: 'user',
      value: 'user-1',
    })
  })

  it('falls back to the address for an anonymous caller', () => {
    expect(rateLimitIdentity({ userId: null, clientIp: '203.0.113.7' })).toEqual({
      kind: 'ip',
      value: '203.0.113.7',
    })
  })

  it('treats an empty user id as no user', () => {
    expect(rateLimitIdentity({ userId: '', clientIp: '203.0.113.7' }).kind).toBe('ip')
  })

  it('uses one shared bucket when there is no identity at all', () => {
    // A deliberate choice: a shared bucket fails visibly, skipping the limit
    // fails silently in the direction of no protection.
    expect(rateLimitIdentity({ userId: null, clientIp: null })).toEqual({
      kind: 'unknown',
      value: 'unknown',
    })
  })
})

describe('rateLimitStoreKey', () => {
  it('scopes a bucket by rule, so two route groups never share a counter', () => {
    const identity = { kind: 'ip', value: '203.0.113.7' } as const

    expect(rateLimitStoreKey('/api/auth/login', identity)).not.toBe(
      rateLimitStoreKey('/api/**', identity),
    )
  })

  it('separates a user from an address that happens to read the same', () => {
    expect(rateLimitStoreKey('/api/**', { kind: 'user', value: '203.0.113.7' })).not.toBe(
      rateLimitStoreKey('/api/**', { kind: 'ip', value: '203.0.113.7' }),
    )
  })

  it('encodes every part, so a colon cannot forge another bucket', () => {
    // A user id is application data. Unencoded, `x:ip:203.0.113.7` in the id
    // field would address a bucket in the IP namespace.
    const forged = rateLimitStoreKey('/api/**', { kind: 'user', value: 'x:ip:203.0.113.7' })

    expect(forged).not.toBe(rateLimitStoreKey('/api/**', { kind: 'ip', value: '203.0.113.7' }))
    expect(forged).toBe('%2Fapi%2F**:user:x%3Aip%3A203.0.113.7')
  })

  it('is stable for the same rule and identity', () => {
    const key = () => rateLimitStoreKey('/api/**', { kind: 'ip', value: '203.0.113.7' })

    expect(key()).toBe(key())
  })
})
