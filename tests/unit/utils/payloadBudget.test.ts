import { describe, it, expect } from 'vitest'

import {
  DEFAULT_PAYLOAD_BUDGET_BYTES,
  checkPayloadBudget,
  formatBytes,
  measurePayloadBytes,
  payloadBudgetWarning,
  payloadFieldSizes,
} from '../../../utils/payloadBudget'

describe('measurePayloadBytes', () => {
  it('measures the JSON form, not the object', () => {
    expect(measurePayloadBytes({ a: 1 })).toBe('{"a":1}'.length)
  })

  it('counts UTF-8 bytes rather than characters', () => {
    // "é" is two bytes and "😀" is four — a payload budget is about what
    // crosses the wire, and `String.length` would under-report both.
    expect(measurePayloadBytes('é')).toBe(4) // quotes + 2 bytes
    expect(measurePayloadBytes('😀')).toBe(6) // quotes + 4 bytes
  })

  it('returns null for a value with no JSON form', () => {
    expect(measurePayloadBytes(undefined)).toBeNull()
    expect(measurePayloadBytes(() => undefined)).toBeNull()
  })

  it('returns null for a circular structure instead of throwing', () => {
    const circular: Record<string, unknown> = {}
    circular['self'] = circular

    expect(measurePayloadBytes(circular)).toBeNull()
  })

  it('returns null for a BigInt, which JSON refuses', () => {
    expect(measurePayloadBytes({ n: 1n })).toBeNull()
  })
})

describe('formatBytes', () => {
  it.each([
    [0, '0 B'],
    [512, '512 B'],
    [1024, '1.00 kB'],
    [20_480, '20.0 kB'],
    [1024 * 1024, '1.00 MB'],
  ])('formats %i as %s', (bytes, expected) => {
    expect(formatBytes(bytes)).toBe(expected)
  })

  it('says so rather than printing NaN', () => {
    expect(formatBytes(Number.NaN)).toBe('unknown')
  })
})

describe('payloadFieldSizes', () => {
  it('reports fields largest first', () => {
    const sizes = payloadFieldSizes({ id: 'a', body: 'x'.repeat(100) })

    expect(sizes.map((entry) => entry.field)).toEqual(['body', 'id'])
  })

  it('breaks ties on field name, so the report does not shuffle between runs', () => {
    const sizes = payloadFieldSizes({ b: 'xx', a: 'xx', c: 'xx' })

    expect(sizes.map((entry) => entry.field)).toEqual(['a', 'b', 'c'])
  })

  it('reports array indices, since an array is where a payload usually grows', () => {
    expect(payloadFieldSizes(['a', 'bb']).map((entry) => entry.field)).toEqual(['1', '0'])
  })

  it('skips a field with no JSON form rather than reporting it as 0 bytes', () => {
    expect(payloadFieldSizes({ id: 'a', fn: () => undefined })).toEqual([{ field: 'id', bytes: 3 }])
  })

  it('has nothing to say about a scalar', () => {
    expect(payloadFieldSizes('hello')).toEqual([])
    expect(payloadFieldSizes(null)).toEqual([])
  })
})

describe('checkPayloadBudget', () => {
  it('passes a value inside its budget', () => {
    const report = checkPayloadBudget('posts', { id: 'a' }, 1024)

    expect(report).toMatchObject({ key: 'posts', withinBudget: true, budgetBytes: 1024 })
    expect(report.bytes).toBeGreaterThan(0)
  })

  it('does not compute a field breakdown for a value that fits', () => {
    // Measuring every field of an in-budget response would re-serialize it on
    // every fetch to produce a report nothing reads.
    expect(checkPayloadBudget('posts', { id: 'a', body: 'b' }, 1024).largestFields).toEqual([])
  })

  it('fails a value over its budget and names what to drop', () => {
    const report = checkPayloadBudget('posts', { id: 'a', body: 'x'.repeat(200) }, 64)

    expect(report.withinBudget).toBe(false)
    expect(report.largestFields[0]?.field).toBe('body')
  })

  it('names at most five fields', () => {
    const wide = Object.fromEntries(
      Array.from({ length: 10 }, (_, i) => [`f${i}`, 'x'.repeat(50 - i)]),
    )

    expect(checkPayloadBudget('wide', wide, 10).largestFields).toHaveLength(5)
  })

  it('treats an unmeasurable value as within budget rather than as a failure', () => {
    // There is no size to compare, and a budget check is not the place to
    // report that a value will not serialize.
    expect(checkPayloadBudget('posts', undefined, 1).withinBudget).toBe(true)
  })

  it('defaults to a 16 kB budget', () => {
    expect(checkPayloadBudget('posts', { id: 'a' }).budgetBytes).toBe(DEFAULT_PAYLOAD_BUDGET_BYTES)
    expect(DEFAULT_PAYLOAD_BUDGET_BYTES).toBe(16 * 1024)
  })
})

describe('payloadBudgetWarning', () => {
  it('is null for a report that passed', () => {
    expect(payloadBudgetWarning(checkPayloadBudget('posts', { id: 'a' }, 1024))).toBeNull()
  })

  it('names the key, both sizes, the worst field, and the fix', () => {
    const warning = payloadBudgetWarning(
      checkPayloadBudget('posts', { id: 'a', body: 'x'.repeat(200) }, 64),
    )

    expect(warning).toContain('"posts"')
    expect(warning).toContain('64 B budget')
    expect(warning).toContain('body')
    expect(warning).toContain('`pick` or `transform`')
  })

  it('reads correctly when there are no fields to name', () => {
    const warning = payloadBudgetWarning(checkPayloadBudget('posts', 'x'.repeat(100), 16))

    expect(warning).toContain('"posts"')
    expect(warning).not.toContain('Largest fields')
  })
})
