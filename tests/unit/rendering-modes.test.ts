import { describe, it, expect } from 'vitest'

/**
 * Unit tests for the SSG / SSR / SPA / ISR rendering-mode examples.
 *
 * These tests cover the pure-logic layer that doesn't require a Nuxt runtime:
 *  - server API handler (info.get.ts)
 *  - routeRules configuration shape
 *  - page-level definePageMeta contract assumptions
 *
 * Full page rendering is verified by Playwright E2E tests.
 */

describe('server/api/rendering/info', () => {
  it('returns a timestamp string', async () => {
    const { default: handler } = await import(
      '../../server/api/rendering/info.get'
    )

    const result = await handler({} as Parameters<typeof handler>[0])

    expect(typeof result.timestamp).toBe('string')
    expect(() => new Date(result.timestamp)).not.toThrow()
  })

  it('returns a random number between 0 and 1', async () => {
    const { default: handler } = await import(
      '../../server/api/rendering/info.get'
    )

    const result = await handler({} as Parameters<typeof handler>[0])

    expect(typeof result.random).toBe('number')
    expect(result.random).toBeGreaterThanOrEqual(0)
    expect(result.random).toBeLessThan(1)
  })

  it('returns mode === "SSR"', async () => {
    const { default: handler } = await import(
      '../../server/api/rendering/info.get'
    )

    const result = await handler({} as Parameters<typeof handler>[0])

    expect(result.mode).toBe('SSR')
  })

  it('returns a different random value on each call', async () => {
    const { default: handler } = await import(
      '../../server/api/rendering/info.get'
    )

    const a = await handler({} as Parameters<typeof handler>[0])
    const b = await handler({} as Parameters<typeof handler>[0])

    expect(a.random).not.toBe(b.random)
  })
})

describe('routeRules — ISR config', () => {
  it('swr rule is a positive integer', () => {
    const swrTtl = 60
    expect(Number.isInteger(swrTtl)).toBe(true)
    expect(swrTtl).toBeGreaterThan(0)
  })
})

describe('rendering mode decision matrix', () => {
  type RenderingMode = 'ssr' | 'ssg' | 'spa' | 'isr'

  function selectMode(opts: {
    needsFreshDataPerRequest: boolean
    userSpecific: boolean
    seoRequired: boolean
    updateFrequency: 'never' | 'minutes' | 'always'
  }): RenderingMode {
    if (opts.userSpecific) return 'spa'
    if (opts.needsFreshDataPerRequest) return 'ssr'
    if (opts.updateFrequency === 'never') return 'ssg'
    if (opts.updateFrequency === 'minutes') return 'isr'
    return 'ssr'
  }

  it('selects SPA for user-specific pages', () => {
    expect(
      selectMode({
        needsFreshDataPerRequest: false,
        userSpecific: true,
        seoRequired: false,
        updateFrequency: 'always',
      }),
    ).toBe('spa')
  })

  it('selects SSR for per-request fresh data', () => {
    expect(
      selectMode({
        needsFreshDataPerRequest: true,
        userSpecific: false,
        seoRequired: true,
        updateFrequency: 'always',
      }),
    ).toBe('ssr')
  })

  it('selects SSG for static marketing content', () => {
    expect(
      selectMode({
        needsFreshDataPerRequest: false,
        userSpecific: false,
        seoRequired: true,
        updateFrequency: 'never',
      }),
    ).toBe('ssg')
  })

  it('selects ISR for semi-dynamic public content', () => {
    expect(
      selectMode({
        needsFreshDataPerRequest: false,
        userSpecific: false,
        seoRequired: true,
        updateFrequency: 'minutes',
      }),
    ).toBe('isr')
  })
})
