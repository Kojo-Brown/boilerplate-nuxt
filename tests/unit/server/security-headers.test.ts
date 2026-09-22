import { describe, it, expect } from 'vitest'

import { routeRules } from '~/route-rules.config'
import {
  buildContentSecurityPolicy,
  buildSecurityHeaders,
  buildStrictTransportSecurity,
  clampHstsMaxAge,
  DEFAULT_HSTS_MAX_AGE_SECONDS,
  isSecureRequest,
  MAX_HSTS_MAX_AGE_SECONDS,
  parseSourceList,
  resolveSecurityConfig,
  servesSharedHtml,
  sharedHtmlPatterns,
  type SecurityConfig,
} from '~/server/utils/security-headers'

const NONCE = 'dGVzdC1ub25jZS12YWw='

/** The resolved defaults, i.e. what an unconfigured deployment gets. */
const defaults: SecurityConfig = resolveSecurityConfig({})

/** Pulls one directive out of a policy string so a test can name what it means. */
function directive(policy: string, name: string): string | undefined {
  return policy
    .split('; ')
    .find((entry) => entry === name || entry.startsWith(`${name} `))
    ?.replace(new RegExp(`^${name} ?`), '')
}

describe('parseSourceList', () => {
  it('splits, trims and de-duplicates', () => {
    expect(
      parseSourceList(' https://cdn.example.com , https://a.example.com ,https://cdn.example.com'),
    ).toEqual(['https://cdn.example.com', 'https://a.example.com'])
  })

  it('accepts an array as well as a comma-separated string', () => {
    expect(parseSourceList(['https://a.example.com', 'wss://b.example.com'])).toEqual([
      'https://a.example.com',
      'wss://b.example.com',
    ])
  })

  it('is empty for an unset value', () => {
    expect(parseSourceList(undefined)).toEqual([])
    expect(parseSourceList('')).toEqual([])
    expect(parseSourceList('  ,  ')).toEqual([])
  })

  it('drops anything that could append a directive of its own', () => {
    // The whole reason this validates rather than escapes: a semicolon in an
    // environment variable is a response-header injection.
    expect(parseSourceList('https://ok.example.com;script-src *')).toEqual([])
    expect(parseSourceList("'unsafe-inline'")).toEqual([])
    expect(parseSourceList('https://ok.example.com\nscript-src *')).toEqual([])
    expect(parseSourceList('a'.repeat(300))).toEqual([])
  })

  it('keeps the valid entries of a partly invalid list', () => {
    expect(parseSourceList("https://ok.example.com,'unsafe-eval'")).toEqual([
      'https://ok.example.com',
    ])
  })
})

describe('clampHstsMaxAge', () => {
  it('defaults to a year when unset or unparseable', () => {
    expect(clampHstsMaxAge(undefined)).toBe(DEFAULT_HSTS_MAX_AGE_SECONDS)
    expect(clampHstsMaxAge('not-a-number')).toBe(DEFAULT_HSTS_MAX_AGE_SECONDS)
  })

  it('reads the string an env var actually delivers', () => {
    expect(clampHstsMaxAge('600')).toBe(600)
  })

  it('clamps to 0…two years', () => {
    expect(clampHstsMaxAge(-1)).toBe(0)
    expect(clampHstsMaxAge(MAX_HSTS_MAX_AGE_SECONDS + 1)).toBe(MAX_HSTS_MAX_AGE_SECONDS)
  })

  it('keeps zero, because it is the only way back off HSTS', () => {
    expect(clampHstsMaxAge(0)).toBe(0)
  })
})

describe('resolveSecurityConfig', () => {
  it('enforces by default', () => {
    expect(defaults.cspMode).toBe('enforce')
    expect(defaults.reportUri).toBe('')
    expect(defaults.hsts).toEqual({
      maxAgeSeconds: DEFAULT_HSTS_MAX_AGE_SECONDS,
      includeSubdomains: true,
      preload: false,
    })
  })

  it('accepts the three modes and falls back to enforce for anything else', () => {
    expect(resolveSecurityConfig({ security: { csp: { mode: 'report-only' } } }).cspMode).toBe(
      'report-only',
    )
    expect(resolveSecurityConfig({ security: { csp: { mode: ' OFF ' } } }).cspMode).toBe('off')
    expect(resolveSecurityConfig({ security: { csp: { mode: 'lenient' } } }).cspMode).toBe(
      'enforce',
    )
  })

  it('reads booleans the way an env var spells them', () => {
    const config = resolveSecurityConfig({
      security: { hsts: { includeSubdomains: 'false', preload: 'true' } },
    })

    expect(config.hsts.includeSubdomains).toBe(false)
    expect(config.hsts.preload).toBe(true)
  })

  it('takes a same-origin path or an absolute http(s) report endpoint, and nothing else', () => {
    expect(
      resolveSecurityConfig({ security: { csp: { reportUri: '/api/csp-report' } } }).reportUri,
    ).toBe('/api/csp-report')
    expect(
      resolveSecurityConfig({ security: { csp: { reportUri: 'https://csp.example.com/r' } } })
        .reportUri,
    ).toBe('https://csp.example.com/r')
    expect(
      resolveSecurityConfig({ security: { csp: { reportUri: 'javascript:alert(1)' } } }).reportUri,
    ).toBe('')
    expect(
      resolveSecurityConfig({ security: { csp: { reportUri: '/r; script-src *' } } }).reportUri,
    ).toBe('')
  })
})

describe('buildContentSecurityPolicy', () => {
  const rendered = buildContentSecurityPolicy({
    nonce: NONCE,
    dev: false,
    secure: true,
    config: defaults,
  })

  it('is the whole policy, in a fixed order, for a rendered page over TLS', () => {
    expect(rendered).toBe(
      [
        "default-src 'self'",
        "base-uri 'none'",
        "object-src 'none'",
        `script-src 'self' 'nonce-${NONCE}'`,
        `style-src 'self' 'nonce-${NONCE}'`,
        "style-src-attr 'unsafe-inline'",
        "img-src 'self' data: blob:",
        "font-src 'self' data:",
        "connect-src 'self'",
        "media-src 'self'",
        "worker-src 'self' blob:",
        "manifest-src 'self'",
        "frame-src 'none'",
        "frame-ancestors 'none'",
        "form-action 'self'",
        'upgrade-insecure-requests',
      ].join('; '),
    )
  })

  it('never puts a nonce and `unsafe-inline` in the same directive', () => {
    // A browser that understands the nonce ignores `'unsafe-inline'`, so the two
    // together would silently mean "any inline script runs".
    for (const dev of [false, true]) {
      const scriptSrc = directive(
        buildContentSecurityPolicy({ nonce: NONCE, dev, secure: true, config: defaults }),
        'script-src',
      )

      expect(scriptSrc).toContain(`'nonce-${NONCE}'`)
      expect(scriptSrc).not.toContain("'unsafe-inline'")
    }
  })

  it('falls back to `unsafe-inline` when there is no nonce to offer', () => {
    const policy = buildContentSecurityPolicy({
      nonce: null,
      dev: false,
      secure: true,
      config: defaults,
    })

    expect(directive(policy, 'script-src')).toBe("'self' 'unsafe-inline'")
    expect(directive(policy, 'style-src')).toBe("'self' 'unsafe-inline'")
  })

  it('allows the eval and the inline styles Vite needs, in development only', () => {
    const dev = buildContentSecurityPolicy({
      nonce: NONCE,
      dev: true,
      secure: false,
      config: defaults,
    })

    expect(directive(dev, 'script-src')).toBe(`'self' 'nonce-${NONCE}' 'unsafe-eval'`)
    expect(directive(dev, 'style-src')).toBe("'self' 'unsafe-inline'")
    expect(directive(rendered, 'script-src')).not.toContain("'unsafe-eval'")
  })

  it('only upgrades insecure requests over TLS', () => {
    const plain = buildContentSecurityPolicy({
      nonce: NONCE,
      dev: false,
      secure: false,
      config: defaults,
    })

    expect(plain).not.toContain('upgrade-insecure-requests')
  })

  it('appends configured origins to the directive they belong to', () => {
    const config = resolveSecurityConfig({
      security: {
        csp: {
          connectSrc: 'https://api.example.com,wss://live.example.com',
          imgSrc: 'https://cdn.example.com',
          frameAncestors: 'https://portal.example.com',
        },
      },
    })
    const policy = buildContentSecurityPolicy({ nonce: NONCE, dev: false, secure: true, config })

    expect(directive(policy, 'connect-src')).toBe(
      "'self' https://api.example.com wss://live.example.com",
    )
    expect(directive(policy, 'img-src')).toBe("'self' data: blob: https://cdn.example.com")
    expect(directive(policy, 'frame-ancestors')).toBe('https://portal.example.com')
  })

  it('appends report-uri last, when one is configured', () => {
    const config = resolveSecurityConfig({ security: { csp: { reportUri: '/api/csp-report' } } })
    const policy = buildContentSecurityPolicy({ nonce: NONCE, dev: false, secure: true, config })

    expect(policy.endsWith('report-uri /api/csp-report')).toBe(true)
  })
})

describe('buildStrictTransportSecurity', () => {
  it('includes subdomains by default', () => {
    expect(buildStrictTransportSecurity(defaults.hsts)).toBe(
      `max-age=${DEFAULT_HSTS_MAX_AGE_SECONDS}; includeSubDomains`,
    )
  })

  it('serialises the retreat value', () => {
    expect(
      buildStrictTransportSecurity({
        maxAgeSeconds: 0,
        includeSubdomains: false,
        preload: false,
      }),
    ).toBe('max-age=0')
  })

  it('adds preload when the list would actually accept the directive', () => {
    expect(
      buildStrictTransportSecurity({
        maxAgeSeconds: DEFAULT_HSTS_MAX_AGE_SECONDS,
        includeSubdomains: true,
        preload: true,
      }),
    ).toBe(`max-age=${DEFAULT_HSTS_MAX_AGE_SECONDS}; includeSubDomains; preload`)
  })

  it('drops preload when the other two requirements are not met', () => {
    expect(
      buildStrictTransportSecurity({ maxAgeSeconds: 600, includeSubdomains: true, preload: true }),
    ).toBe('max-age=600; includeSubDomains')
    expect(
      buildStrictTransportSecurity({
        maxAgeSeconds: DEFAULT_HSTS_MAX_AGE_SECONDS,
        includeSubdomains: false,
        preload: true,
      }),
    ).toBe(`max-age=${DEFAULT_HSTS_MAX_AGE_SECONDS}`)
  })
})

describe('buildSecurityHeaders', () => {
  const secure = buildSecurityHeaders({ nonce: NONCE, dev: false, secure: true, config: defaults })

  it('sets the static headers on every response', () => {
    expect(secure['x-content-type-options']).toBe('nosniff')
    expect(secure['x-frame-options']).toBe('DENY')
    expect(secure['referrer-policy']).toBe('strict-origin-when-cross-origin')
    expect(secure['cross-origin-opener-policy']).toBe('same-origin')
    expect(secure['cross-origin-resource-policy']).toBe('same-origin')
    expect(secure['permissions-policy']).toContain('camera=()')
    expect(secure['permissions-policy']).toContain('geolocation=()')
  })

  it('sends HSTS only over TLS', () => {
    expect(secure['strict-transport-security']).toBe(
      `max-age=${DEFAULT_HSTS_MAX_AGE_SECONDS}; includeSubDomains`,
    )
    expect(
      buildSecurityHeaders({ nonce: NONCE, dev: false, secure: false, config: defaults }),
    ).not.toHaveProperty('strict-transport-security')
  })

  it('moves the policy to the report-only header in report-only mode', () => {
    const config = resolveSecurityConfig({ security: { csp: { mode: 'report-only' } } })
    const headers = buildSecurityHeaders({ nonce: NONCE, dev: false, secure: true, config })

    expect(headers).not.toHaveProperty('content-security-policy')
    expect(headers['content-security-policy-report-only']).toContain(`'nonce-${NONCE}'`)
  })

  it('sends no policy at all when the CSP is off, and keeps everything else', () => {
    const config = resolveSecurityConfig({ security: { csp: { mode: 'off' } } })
    const headers = buildSecurityHeaders({ nonce: NONCE, dev: false, secure: true, config })

    expect(headers).not.toHaveProperty('content-security-policy')
    expect(headers).not.toHaveProperty('content-security-policy-report-only')
    expect(headers['x-content-type-options']).toBe('nosniff')
  })

  it('emits header names lowercased, so a later `setResponseHeader` replaces rather than doubles', () => {
    for (const name of Object.keys(secure)) {
      expect(name).toBe(name.toLowerCase())
    }
  })
})

describe('isSecureRequest', () => {
  it('trusts x-forwarded-proto when a proxy set one', () => {
    expect(isSecureRequest({ forwardedProto: 'https' })).toBe(true)
    expect(isSecureRequest({ forwardedProto: 'http' })).toBe(false)
  })

  it('reads the first entry of a chained header', () => {
    expect(isSecureRequest({ forwardedProto: 'https, http' })).toBe(true)
    expect(isSecureRequest({ forwardedProto: ' HTTPS ' })).toBe(true)
  })

  it('falls back to the socket when there is no proxy header', () => {
    expect(isSecureRequest({ socket: { encrypted: true } })).toBe(true)
    expect(isSecureRequest({ socket: { encrypted: false } })).toBe(false)
    expect(isSecureRequest({})).toBe(false)
  })

  it('reads a plain TCP socket, and a preset that has no socket at all, as insecure', () => {
    expect(isSecureRequest({ socket: {} })).toBe(false)
    expect(isSecureRequest({ socket: null })).toBe(false)
    expect(isSecureRequest({ socket: undefined })).toBe(false)
  })

  it('lets the proxy header override a TLS socket, since the proxy is the edge', () => {
    expect(isSecureRequest({ forwardedProto: 'http', socket: { encrypted: true } })).toBe(false)
  })
})

describe('sharedHtmlPatterns', () => {
  it('derives the exceptions from the project route rules', () => {
    // Both of these are pages whose HTML outlives the request that made it:
    // `/route-rules/static` is written at build time, `/rendering/isr` is held
    // for 60 seconds by an swr rule.
    expect(sharedHtmlPatterns()).toEqual(['/rendering/isr', '/route-rules/static'])
  })

  it('ignores cached API routes, which have no inline script to authorise', () => {
    for (const pattern of sharedHtmlPatterns()) {
      expect(pattern.startsWith('/api')).toBe(false)
    }
    expect(routeRules['/api/route-rules/swr']).toHaveProperty('swr')
  })

  it('reads prerender: false as what it is', () => {
    expect(
      sharedHtmlPatterns({
        '/off': { prerender: false },
        '/on': { prerender: true },
      }),
    ).toEqual(['/on'])
  })

  it('counts isr as well as swr', () => {
    expect(sharedHtmlPatterns({ '/isr': { isr: 60 } })).toEqual(['/isr'])
  })
})

describe('servesSharedHtml', () => {
  it('matches the prerendered and cached pages of this project', () => {
    expect(servesSharedHtml('/route-rules/static')).toBe(true)
    expect(servesSharedHtml('/rendering/isr')).toBe(true)
  })

  it('leaves every other path with a nonce', () => {
    expect(servesSharedHtml('/')).toBe(false)
    expect(servesSharedHtml('/route-rules')).toBe(false)
    expect(servesSharedHtml('/api/todos')).toBe(false)
    expect(servesSharedHtml('/api/route-rules/swr')).toBe(false)
  })

  it('does not treat a longer path as a match for an exact key', () => {
    expect(servesSharedHtml('/route-rules/static-ish')).toBe(false)
    expect(servesSharedHtml('/route-rules/static/nested')).toBe(false)
  })

  it('matches a wildcard key and everything under it', () => {
    const rules = { '/docs/**': { prerender: true } }

    expect(servesSharedHtml('/docs', rules)).toBe(true)
    expect(servesSharedHtml('/docs/a/b', rules)).toBe(true)
    expect(servesSharedHtml('/docsy', rules)).toBe(false)
  })
})
