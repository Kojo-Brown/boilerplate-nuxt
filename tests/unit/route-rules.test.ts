import { describe, it, expect } from 'vitest'

import { routeRules } from '../../route-rules.config'

/**
 * These tests pin the route-rules *contract*: which path gets which rule. The
 * runtime effect of each rule (cache headers, prerendered files, CORS headers)
 * is Nitro's own, exercised by `pnpm build` and by curling the built server —
 * see docs/nitro-route-rules.md. What can break silently here is the config: a
 * renamed path or a dropped rule, which these tests catch.
 *
 * `defineEventHandler` is stubbed to an identity wrapper in tests/setup.ts, so
 * the demo handlers can be imported and invoked directly with a minimal event.
 */

type MinimalEvent = Parameters<
  Awaited<typeof import('../../server/api/route-rules/swr.get')>['default']
>[0]

const event = {} as MinimalEvent

describe('route-rules.config', () => {
  it('declares every rule with a leading-slash path', () => {
    for (const path of Object.keys(routeRules)) {
      expect(path.startsWith('/')).toBe(true)
    }
  })

  it('prerenders the static page and only that page', () => {
    expect(routeRules['/route-rules/static']).toEqual({ prerender: true })
    // The dynamic index must stay out of the prerender crawl.
    expect(routeRules['/route-rules']).toEqual({ prerender: false })
  })

  it('caches the SWR API for 30 seconds', () => {
    expect(routeRules['/api/route-rules/swr']).toEqual({ swr: 30 })
  })

  it('keeps the rendering-demo ISR page on a 60-second SWR window', () => {
    expect(routeRules['/rendering/isr']).toEqual({ swr: 60 })
  })

  it('marks the ISR API with the isr rule', () => {
    expect(routeRules['/api/route-rules/isr']).toEqual({ isr: 60 })
  })

  it('enables CORS on the public API with an explicit method/preflight policy', () => {
    const rule = routeRules['/api/route-rules/cors']
    expect(rule?.cors).toBe(true)
    // The explicit headers narrow the permissive `cors: true` defaults; the
    // preflight cache is a real (non-zero) duration.
    expect(rule?.headers).toMatchObject({
      'access-control-allow-methods': 'GET,OPTIONS',
      'access-control-max-age': '600',
    })
  })
})

describe('demo API handlers', () => {
  it('swr handler returns a well-formed, timestamped sample', async () => {
    const { default: handler } = await import('../../server/api/route-rules/swr.get')
    const result = handler(event)

    expect(result.rule).toBe('swr')
    expect(() => new Date(result.renderedAt).toISOString()).not.toThrow()
    expect(new Date(result.renderedAt).toISOString()).toBe(result.renderedAt)
    expect(Number.isInteger(result.random)).toBe(true)
  })

  it('isr handler is tagged isr and shares the sample shape', async () => {
    const { default: handler } = await import('../../server/api/route-rules/isr.get')
    const result = handler(event)

    expect(result.rule).toBe('isr')
    expect(typeof result.renderedAt).toBe('string')
    expect(typeof result.note).toBe('string')
  })

  it('cors handler returns the public framework dataset', async () => {
    const { default: handler } = await import('../../server/api/route-rules/cors.get')
    const result = handler(event)

    expect(result.rule).toBe('cors')
    expect(result.frameworks.length).toBeGreaterThan(0)
    expect(result.frameworks.every((f) => typeof f.name === 'string' && f.firstReleased > 0)).toBe(
      true,
    )
    // A returned array must not alias the module-level source data.
    const ids = result.frameworks.map((f) => f.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})
