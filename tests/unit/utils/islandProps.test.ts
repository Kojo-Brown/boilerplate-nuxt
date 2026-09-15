import { describe, it, expect } from 'vitest'

import {
  ISLAND_PROPS_BUDGET_BYTES,
  inspectIslandProps,
  islandPropWarnings,
  serialiseIslandProps,
  type IslandPropIssueKind,
} from '../../../utils/islandProps'

/**
 * Two things are being pinned here.
 *
 * The first is the serialisation, which has to match what `<NuxtIsland>` puts in
 * the URL — `JSON.stringify` over the props with `data-v-*` keys removed. Nuxt
 * exports the same function as `serializeIslandProps` from `nuxt/app`, but that
 * entry point resolves `#build/*` aliases and so cannot be imported from a plain
 * Vitest process; the behaviour is asserted directly instead, which is the part
 * that would break if either side drifted.
 *
 * The second is the report. Each case below is a failure mode that produces no
 * error at runtime: the island renders, it just renders against props that are
 * not the props the page passed.
 */

function kinds(props: Record<string, unknown>): IslandPropIssueKind[] {
  return inspectIslandProps(props).issues.map((issue) => issue.kind)
}

function paths(props: Record<string, unknown>, kind: IslandPropIssueKind): string[] {
  return inspectIslandProps(props)
    .issues.filter((issue) => issue.kind === kind)
    .map((issue) => issue.path)
}

describe('serialiseIslandProps', () => {
  it('serialises props as JSON', () => {
    expect(serialiseIslandProps({ slug: 'a', page: 2 })).toBe('{"slug":"a","page":2}')
  })

  it('serialises undefined props as an empty object, the way NuxtIsland does', () => {
    expect(serialiseIslandProps(undefined)).toBe('{}')
  })

  it('drops data-v-* keys, which are scoped-style markers rather than island input', () => {
    expect(serialiseIslandProps({ 'data-v-1234abc': '', slug: 'a' })).toBe('{"slug":"a"}')
  })

  it('returns null when the props have no JSON form', () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic

    expect(serialiseIslandProps(cyclic)).toBeNull()
    expect(serialiseIslandProps({ big: 1n })).toBeNull()
  })
})

describe('inspectIslandProps — clean props', () => {
  it('reports nothing for an identifier prop', () => {
    const report = inspectIslandProps({ slug: 'what-an-island-is' })

    expect(report.ok).toBe(true)
    expect(report.issues).toEqual([])
    expect(report.serialised).toBe('{"slug":"what-an-island-is"}')
    expect(report.budgetBytes).toBe(ISLAND_PROPS_BUDGET_BYTES)
  })

  it('measures the percent-encoded size, which is what the query string costs', () => {
    // `{"slug":"a"}` is 12 characters, of which the braces, quotes and colon are
    // all percent-encoded to three bytes each — the URL cost, not the JSON cost.
    const report = inspectIslandProps({ slug: 'a' })

    expect(report.bytes).toBe(encodeURIComponent('{"slug":"a"}').length)
    expect(report.bytes).toBeGreaterThan('{"slug":"a"}'.length)
  })

  it('ignores data-v-* keys in the walk as well as in the serialisation', () => {
    expect(inspectIslandProps({ 'data-v-1234abc': undefined, slug: 'a' }).ok).toBe(true)
  })

  it('treats undefined props as empty rather than as a problem', () => {
    expect(inspectIslandProps(undefined).ok).toBe(true)
  })
})

describe('inspectIslandProps — values JSON changes', () => {
  it('flags a key whose value JSON drops', () => {
    expect(kinds({ slug: undefined })).toContain('dropped')
    expect(kinds({ onSelect: () => {} })).toContain('dropped')
    expect(kinds({ marker: Symbol('x') })).toContain('dropped')
  })

  it('flags a non-finite number, which arrives as null', () => {
    expect(kinds({ retries: Number.NaN })).toContain('coerced')
    expect(kinds({ limit: Number.POSITIVE_INFINITY })).toContain('coerced')
  })

  it('flags a Date, which arrives as a string', () => {
    expect(kinds({ since: new Date('2026-09-15T00:00:00.000Z') })).toContain('coerced')
  })

  it('flags a hole in an array as coerced rather than dropped', () => {
    // The distinction is the point: in an object the key disappears, in an array
    // the element becomes null and every later index still shifts into place.
    expect(kinds({ ids: ['a', undefined, 'b'] })).toEqual(['coerced'])
    expect(paths({ ids: ['a', undefined, 'b'] }, 'coerced')).toEqual(['ids[1]'])
  })

  it('walks nested objects and reports a dotted path', () => {
    expect(paths({ filters: { since: undefined } }, 'dropped')).toEqual(['filters.since'])
    expect(paths({ rows: [{ at: new Date() }] }, 'coerced')).toEqual(['rows[0].at'])
  })

  it('reports props that cannot be serialised at all', () => {
    const report = inspectIslandProps({ total: 10n })

    expect(report.serialised).toBeNull()
    expect(report.bytes).toBe(0)
    expect(report.ok).toBe(false)
    expect(report.issues.map((issue) => issue.kind)).toContain('unserialisable')
  })
})

describe('inspectIslandProps — values that must not be in a URL', () => {
  it.each([
    'sessionToken',
    'apiKey',
    'api_key',
    'PASSWORD',
    'authorization',
    'refreshSecret',
    'cookie',
    'privateId',
  ])('flags %s as sensitive', (key) => {
    expect(kinds({ [key]: 'mock-value' })).toContain('sensitive')
  })

  it('flags a sensitive key nested inside an object', () => {
    expect(paths({ user: { accessToken: 'mock-access-token' } }, 'sensitive')).toEqual([
      'user.accessToken',
    ])
  })

  it('does not flag an ordinary key', () => {
    expect(kinds({ slug: 'a', page: 2, locale: 'en' })).toEqual([])
  })

  it('still walks a sensitive key for its other problems', () => {
    expect(kinds({ sessionToken: undefined })).toEqual(['sensitive', 'dropped'])
  })
})

describe('inspectIslandProps — budget', () => {
  it('flags props over the budget', () => {
    const report = inspectIslandProps({ body: 'x'.repeat(ISLAND_PROPS_BUDGET_BYTES) })

    expect(report.ok).toBe(false)
    expect(report.issues.map((issue) => issue.kind)).toEqual(['oversize'])
    expect(report.issues[0]?.detail).toContain(String(ISLAND_PROPS_BUDGET_BYTES))
  })

  it('takes a custom budget', () => {
    expect(inspectIslandProps({ slug: 'a' }, 4).ok).toBe(false)
    expect(inspectIslandProps({ slug: 'a' }, 4).budgetBytes).toBe(4)
  })

  it('does not flag props exactly at the budget', () => {
    const report = inspectIslandProps({ slug: 'a' }, inspectIslandProps({ slug: 'a' }).bytes)
    expect(report.ok).toBe(true)
  })
})

describe('islandPropWarnings', () => {
  it('returns nothing for a clean report', () => {
    expect(islandPropWarnings('ContentSection', inspectIslandProps({ slug: 'a' }))).toEqual([])
  })

  it('names the island and the path', () => {
    const [line] = islandPropWarnings('ContentSection', inspectIslandProps({ slug: undefined }))

    expect(line).toContain('[island props] dropped')
    expect(line).toContain('ContentSection.slug')
  })

  it('names the island alone for a whole-object issue', () => {
    const report = inspectIslandProps({ body: 'x'.repeat(ISLAND_PROPS_BUDGET_BYTES) })
    const [line] = islandPropWarnings('ContentSection', report)

    expect(line).toContain('[island props] oversize: ContentSection —')
  })
})
