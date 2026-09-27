import { describe, it, expect } from 'vitest'

import {
  compileRoutePattern,
  matchRouteTable,
  routePatternMatches,
  routePatternSpecificity,
} from '~/server/utils/route-pattern'

/**
 * The matcher shared by the access policy and the rate-limit policy.
 *
 * Both tables are security boundaries that depend on the most specific rule
 * winning, so the ordering rules are asserted here once rather than inferred from
 * each table's own tests.
 */

describe('compileRoutePattern', () => {
  it('reads a trailing /** as a wildcard prefix', () => {
    expect(compileRoutePattern('/api/auth/**')).toEqual({ prefix: '/api/auth', exact: false })
  })

  it('compiles the bare catch-all to an empty prefix', () => {
    expect(compileRoutePattern('/**')).toEqual({ prefix: '', exact: false })
  })

  it('treats anything else as an exact path', () => {
    expect(compileRoutePattern('/api/metrics')).toEqual({ prefix: '/api/metrics', exact: true })
  })
})

describe('routePatternMatches', () => {
  it('matches a wildcard against its own prefix and everything under it', () => {
    const pattern = compileRoutePattern('/api/auth/**')

    expect(routePatternMatches(pattern, '/api/auth')).toBe(true)
    expect(routePatternMatches(pattern, '/api/auth/login')).toBe(true)
    expect(routePatternMatches(pattern, '/api/auth/oauth/github')).toBe(true)
  })

  it('does not let a wildcard bleed into a sibling with a shared prefix', () => {
    // The bug a bare `startsWith` would have: `/api/auth/**` matching
    // `/api/authorise`, which is a different route.
    const pattern = compileRoutePattern('/api/auth/**')

    expect(routePatternMatches(pattern, '/api/authorise')).toBe(false)
    expect(routePatternMatches(pattern, '/api/auth-callback')).toBe(false)
  })

  it('matches the catch-all against anything', () => {
    const pattern = compileRoutePattern('/**')

    for (const path of ['/', '/login', '/_nuxt/entry.js', '/api/todos']) {
      expect(routePatternMatches(pattern, path)).toBe(true)
    }
  })

  it('matches an exact key against only that path', () => {
    const pattern = compileRoutePattern('/api/metrics')

    expect(routePatternMatches(pattern, '/api/metrics')).toBe(true)
    expect(routePatternMatches(pattern, '/api/metrics/detail')).toBe(false)
  })
})

describe('routePatternSpecificity', () => {
  it('ranks a longer prefix above a shorter one', () => {
    expect(routePatternSpecificity(compileRoutePattern('/api/auth/**'))).toBeGreaterThan(
      routePatternSpecificity(compileRoutePattern('/api/**')),
    )
  })

  it('ranks an exact key above a wildcard of the same prefix length', () => {
    expect(routePatternSpecificity(compileRoutePattern('/api/todos'))).toBeGreaterThan(
      routePatternSpecificity(compileRoutePattern('/api/todos/**')),
    )
  })
})

describe('matchRouteTable', () => {
  const table = {
    '/**': 'catch-all',
    '/api/**': 'api',
    '/api/auth/**': 'auth',
    '/api/auth/csrf': 'csrf',
  } as const

  it.each([
    { path: '/login', expected: 'catch-all' },
    { path: '/api/todos', expected: 'api' },
    { path: '/api/auth', expected: 'auth' },
    { path: '/api/auth/login', expected: 'auth' },
    { path: '/api/auth/csrf', expected: 'csrf' },
  ])('resolves $path to the most specific rule', ({ path, expected }) => {
    expect(matchRouteTable(path, table)?.value).toBe(expected)
  })

  it('reports which key won, so a caller can scope a bucket by rule', () => {
    expect(matchRouteTable('/api/auth/login', table)?.pattern).toBe('/api/auth/**')
  })

  it('is insensitive to the order the table is written in', () => {
    const reversed = Object.fromEntries(Object.entries(table).reverse())

    for (const path of ['/login', '/api/todos', '/api/auth/login', '/api/auth/csrf']) {
      expect(matchRouteTable(path, reversed)).toEqual(matchRouteTable(path, table))
    }
  })

  it('returns undefined when nothing matches', () => {
    expect(matchRouteTable('/api/todos', { '/api/auth/**': 'auth' })).toBeUndefined()
  })

  it('distinguishes a matched null from no match at all', () => {
    // The distinction the rate-limit table depends on: `null` is a rule saying
    // "not limited", and `undefined` is the absence of a rule.
    expect(matchRouteTable('/login', { '/**': null })).toEqual({ pattern: '/**', value: null })
    expect(matchRouteTable('/login', {})).toBeUndefined()
  })
})
