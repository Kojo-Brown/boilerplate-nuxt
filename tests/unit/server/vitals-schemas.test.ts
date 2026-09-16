import { describe, it, expect } from 'vitest'

import { parseVitalsBatch, vitalsBatchSchema } from '~/server/utils/vitals-schemas'
import { MAX_SAMPLES_PER_BATCH } from '~/types/vitals'

function validSample(overrides: Record<string, unknown> = {}) {
  return {
    name: 'LCP',
    value: 2100,
    rating: 'good',
    id: 'v1-1',
    navigationType: 'navigate',
    route: '/pricing',
    ...overrides,
  }
}

function validBatch(overrides: Record<string, unknown> = {}) {
  return {
    sentAt: '2026-02-01T10:00:00.000Z',
    page: { visitId: 'visit-1', connection: '4g', viewport: { width: 390, height: 844 } },
    samples: [validSample()],
    ...overrides,
  }
}

describe('vitalsBatchSchema', () => {
  it('accepts a batch the browser half actually produces', () => {
    const result = vitalsBatchSchema.safeParse(validBatch())

    expect(result.success).toBe(true)
  })

  it('accepts a batch with only the required page context', () => {
    expect(vitalsBatchSchema.safeParse(validBatch({ page: { visitId: 'v' } })).success).toBe(true)
  })

  it.each([
    ['an unknown metric name', { samples: [validSample({ name: 'FID' })] }],
    ['an unknown navigation type', { samples: [validSample({ navigationType: 'teleport' })] }],
    ['an unknown rating', { samples: [validSample({ rating: 'fine' })] }],
    ['a negative value', { samples: [validSample({ value: -1 })] }],
    ['an impossible value', { samples: [validSample({ value: 1e308 })] }],
    ['a route that is not a path', { samples: [validSample({ route: 'https://evil.test/x' })] }],
    ['an empty sample list', { samples: [] }],
    ['a timestamp that is not ISO 8601', { sentAt: 'yesterday' }],
    ['a missing visit id', { page: {} }],
  ])('rejects %s', (_label, overrides) => {
    expect(vitalsBatchSchema.safeParse(validBatch(overrides)).success).toBe(false)
  })

  it('rejects unknown keys rather than passing them through to a sink', () => {
    // The endpoint forwards the parsed batch verbatim. Without `.strict()` this
    // app would be an open relay for arbitrary JSON with a schema in front.
    expect(vitalsBatchSchema.safeParse(validBatch({ tracking: 'anything' })).success).toBe(false)
    expect(
      vitalsBatchSchema.safeParse(validBatch({ samples: [validSample({ userId: 'u-1' })] }))
        .success,
    ).toBe(false)
    expect(
      vitalsBatchSchema.safeParse(validBatch({ page: { visitId: 'v', ip: '203.0.113.4' } }))
        .success,
    ).toBe(false)
  })

  it('caps the batch at the size both ends agree on', () => {
    const at = Array.from({ length: MAX_SAMPLES_PER_BATCH }, (_, i) =>
      validSample({ id: `v1-${i}` }),
    )
    const over = [...at, validSample({ id: 'one-too-many' })]

    expect(vitalsBatchSchema.safeParse(validBatch({ samples: at })).success).toBe(true)
    expect(vitalsBatchSchema.safeParse(validBatch({ samples: over })).success).toBe(false)
  })

  it('bounds the strings a forged beacon could grow', () => {
    const long = 'x'.repeat(1000)

    expect(
      vitalsBatchSchema.safeParse(validBatch({ samples: [validSample({ route: `/${long}` })] }))
        .success,
    ).toBe(false)
    expect(
      vitalsBatchSchema.safeParse(validBatch({ samples: [validSample({ id: long })] })).success,
    ).toBe(false)
    expect(vitalsBatchSchema.safeParse(validBatch({ page: { visitId: long } })).success).toBe(false)
  })
})

describe('parseVitalsBatch', () => {
  it('returns the parsed batch', () => {
    const result = parseVitalsBatch(validBatch())

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.batch.samples[0]?.name).toBe('LCP')
  })

  it('returns the first problem as a message instead of throwing', () => {
    const result = parseVitalsBatch(validBatch({ samples: [validSample({ route: 'pricing' })] }))

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain('path')
  })

  it('handles a body that is not an object at all', () => {
    expect(parseVitalsBatch(null).ok).toBe(false)
    expect(parseVitalsBatch('{}').ok).toBe(false)
    expect(parseVitalsBatch(undefined).ok).toBe(false)
  })
})
