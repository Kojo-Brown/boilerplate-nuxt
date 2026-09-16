import { describe, it, expect } from 'vitest'

import { createVitalsAggregate, percentile } from '~/server/utils/vitals-aggregate'
import type { VitalMetricName, VitalSample } from '~/types/vitals'

function sample(name: VitalMetricName, value: number, route = '/'): VitalSample {
  return {
    name,
    value,
    rating: 'good',
    id: `${name}-${value}-${route}`,
    navigationType: 'navigate',
    route,
  }
}

describe('percentile', () => {
  it('uses nearest rank, so it returns a value that was measured', () => {
    expect(percentile([1, 2, 3, 4], 0.75)).toBe(3)
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8], 0.75)).toBe(6)
    // Not the average of 3 and 4, and not an interpolation between them.
    expect(percentile([10, 20, 30, 40], 0.75)).toBe(30)
  })

  it('sorts numerically rather than lexically', () => {
    // The default `Array#sort` comparator would order these as 100, 25, 9.
    expect(percentile([9, 100, 25], 0.75)).toBe(100)
  })

  it('handles the degenerate inputs', () => {
    expect(percentile([], 0.75)).toBe(0)
    expect(percentile([42], 0.75)).toBe(42)
    expect(percentile([1, 2, 3, 4], 0)).toBe(1)
    expect(percentile([1, 2, 3, 4], 1)).toBe(4)
  })
})

describe('createVitalsAggregate', () => {
  it('summarises each metric and route at p75 and rates that number', () => {
    const aggregate = createVitalsAggregate({ now: () => Date.parse('2026-02-01T10:00:00.000Z') })

    // Three good loads and one poor one: the mean would pass, the p75 does not.
    for (const value of [1000, 1200, 1400, 5000]) {
      aggregate.record(sample('LCP', value, '/pricing'))
    }

    const snapshot = aggregate.snapshot()
    const lcp = snapshot.keys.find((key) => key.route === '/pricing')

    expect(lcp).toMatchObject({
      name: 'LCP',
      route: '/pricing',
      retained: 4,
      seen: 4,
      p75: 1400,
      rating: 'good',
      lastSeenAt: '2026-02-01T10:00:00.000Z',
    })
    expect(lcp?.distribution).toEqual({ good: 3, 'needs-improvement': 0, poor: 1 })
    expect(snapshot.generatedAt).toBe('2026-02-01T10:00:00.000Z')
    expect(snapshot.seenSamples).toBe(4)
    expect(snapshot.retainedSamples).toBe(4)
    expect(snapshot.evictedKeys).toBe(0)
  })

  it('keeps one window per metric and route pair', () => {
    const aggregate = createVitalsAggregate()

    aggregate.record(sample('LCP', 1000, '/'))
    aggregate.record(sample('LCP', 9000, '/slow'))
    aggregate.record(sample('CLS', 0.4, '/'))

    expect(aggregate.snapshot().keys.map((key) => `${key.name} ${key.route}`)).toEqual([
      'CLS /',
      'LCP /',
      'LCP /slow',
    ])
  })

  it('rolls the window and says so, rather than growing without bound', () => {
    const aggregate = createVitalsAggregate({ maxSamplesPerKey: 3 })

    // The first two values leave the window; the retained three are 30/40/50.
    for (const value of [9999, 8888, 30, 40, 50]) aggregate.record(sample('TTFB', value))

    const [ttfb] = aggregate.snapshot().keys

    expect(ttfb).toMatchObject({ retained: 3, seen: 5, p75: 50 })
    expect(aggregate.snapshot().retainedSamples).toBe(3)
  })

  it('keeps writing correctly after the ring buffer wraps more than once', () => {
    const aggregate = createVitalsAggregate({ maxSamplesPerKey: 2 })

    for (const value of [1, 2, 3, 4, 5, 6, 7]) aggregate.record(sample('INP', value))

    // Two slots, seven writes: whatever the cursor did, the window holds the
    // last two values and nothing stale.
    const [inp] = aggregate.snapshot().keys
    expect(inp).toMatchObject({ retained: 2, seen: 7, p75: 7 })
    expect(inp?.distribution).toEqual({ good: 2, 'needs-improvement': 0, poor: 0 })
  })

  it('evicts the least recently updated key when the table is full', () => {
    let clock = 0
    const aggregate = createVitalsAggregate({ maxKeys: 2, now: () => clock })

    clock = 1
    aggregate.record(sample('LCP', 1000, '/old'))
    clock = 2
    aggregate.record(sample('LCP', 1000, '/busy'))
    clock = 3
    aggregate.record(sample('LCP', 1100, '/busy'))
    clock = 4
    aggregate.record(sample('LCP', 1200, '/new'))

    const snapshot = aggregate.snapshot()

    expect(snapshot.keys.map((key) => key.route)).toEqual(['/busy', '/new'])
    expect(snapshot.evictedKeys).toBe(1)
    // The counter survives the eviction: a partial summary must admit it is one.
    expect(snapshot.seenSamples).toBe(4)
  })

  it('reports an empty summary before any beacon arrives', () => {
    const snapshot = createVitalsAggregate().snapshot()

    expect(snapshot.keys).toEqual([])
    expect(snapshot.retainedSamples).toBe(0)
    expect(snapshot.seenSamples).toBe(0)
  })

  it('does not let a snapshot disturb the window it measured', () => {
    const aggregate = createVitalsAggregate({ maxSamplesPerKey: 4 })

    for (const value of [400, 100, 300, 200]) aggregate.record(sample('FCP', value))

    const first = aggregate.snapshot().keys[0]
    const second = aggregate.snapshot().keys[0]

    // `percentile` sorts, so a snapshot that handed it the live array would
    // reorder the ring buffer under the write cursor.
    expect(second).toEqual(first)

    // 5000 overwrites the oldest slot (400), leaving 100/200/300/5000.
    aggregate.record(sample('FCP', 5000))
    expect(aggregate.snapshot().keys[0]).toMatchObject({ retained: 4, seen: 5, p75: 300 })
  })
})
