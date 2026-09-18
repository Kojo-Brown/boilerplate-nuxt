import { describe, it, expect } from 'vitest'

import {
  buildReport,
  checkAgainstDocument,
  checkBudgets,
  collectClosure,
  findEntryKey,
  formatBytes,
  formatMarkdownSummary,
  formatReportTable,
  pageChunkKeys,
  routePathFromPageSource,
  type BudgetConfig,
  type ClientManifest,
} from '../../../scripts/bundleBudget'

/**
 * A manifest shaped like the one Nuxt produces, small enough to reason about:
 *
 *   entry ──static──▶ vue ──static──▶ shared
 *         └─dynamic─▶ /a, /b
 *   /a ───static──▶ shared, heavy
 *   /b ───static──▶ shared
 *
 * So `shared` is part of the baseline (the entry reaches it statically), and
 * `heavy` is `/a`'s alone.
 */
const manifest: ClientManifest = {
  'node_modules/nuxt/dist/app/entry.js': {
    file: 'entry.js',
    src: 'node_modules/nuxt/dist/app/entry.js',
    resourceType: 'script',
    isEntry: true,
    imports: ['_vue.js'],
    dynamicImports: ['pages/a.vue', 'pages/b.vue'],
    css: ['entry.css'],
  },
  '_vue.js': {
    file: 'vue.js',
    resourceType: 'script',
    imports: ['_shared.js'],
  },
  '_shared.js': {
    file: 'shared.js',
    resourceType: 'script',
  },
  '_heavy.js': {
    file: 'heavy.js',
    resourceType: 'script',
  },
  'pages/a.vue': {
    file: 'a.js',
    src: 'pages/a.vue',
    resourceType: 'script',
    isDynamicEntry: true,
    imports: ['_shared.js', '_heavy.js'],
    css: ['a.css'],
  },
  'pages/b.vue': {
    file: 'b.js',
    src: 'pages/b.vue',
    resourceType: 'script',
    isDynamicEntry: true,
    imports: ['_shared.js'],
  },
  'entry.css': { file: 'entry.css', resourceType: 'style' },
  'a.css': { file: 'a.css', resourceType: 'style' },
}

/** Raw bytes per file; gzip is modelled as half, which is enough to tell them apart. */
const sizes: Record<string, number> = {
  'entry.js': 1000,
  'vue.js': 4000,
  'shared.js': 2000,
  'heavy.js': 8000,
  'a.js': 600,
  'b.js': 400,
  'entry.css': 500,
  'a.css': 200,
}

const sizeOf = (file: string): { bytes: number; gzipBytes: number } | null => {
  const bytes = sizes[file]
  return bytes === undefined ? null : { bytes, gzipBytes: bytes / 2 }
}

describe('routePathFromPageSource', () => {
  it('maps a top-level page to its path', () => {
    expect(routePathFromPageSource('pages/upload.vue')).toBe('/upload')
  })

  it('maps index pages to the directory they sit in', () => {
    expect(routePathFromPageSource('pages/index.vue')).toBe('/')
    expect(routePathFromPageSource('pages/rendering/index.vue')).toBe('/rendering')
  })

  it('only treats a whole segment named index as the parent path', () => {
    expect(routePathFromPageSource('pages/index-cards.vue')).toBe('/index-cards')
  })

  it('writes dynamic segments the way Nuxt does', () => {
    expect(routePathFromPageSource('pages/users/[id].vue')).toBe('/users/:id()')
    expect(routePathFromPageSource('pages/users/[[id]].vue')).toBe('/users/:id?')
    expect(routePathFromPageSource('pages/docs/[...slug].vue')).toBe('/docs/:slug(.*)*')
  })

  it('handles a param inside a longer segment', () => {
    expect(routePathFromPageSource('pages/user-[id].vue')).toBe('/user-:id()')
  })

  it('accepts a source path with a layer prefix', () => {
    expect(routePathFromPageSource('layers/marketing/pages/pricing.vue')).toBe('/pricing')
  })
})

describe('pageChunkKeys', () => {
  it('finds pages by their source module, not by their manifest key', () => {
    expect(pageChunkKeys(manifest)).toEqual(['pages/a.vue', 'pages/b.vue'])
  })

  it('ignores a page-looking module inside node_modules', () => {
    expect(
      pageChunkKeys({
        'node_modules/some-module/pages/x.vue': {
          file: 'x.js',
          src: 'node_modules/some-module/pages/x.vue',
        },
      }),
    ).toEqual([])
  })
})

describe('findEntryKey', () => {
  it('returns the single entry chunk', () => {
    expect(findEntryKey(manifest)).toBe('node_modules/nuxt/dist/app/entry.js')
  })

  it('throws rather than guessing when there is no entry', () => {
    expect(() => findEntryKey({ '_a.js': { file: 'a.js' } })).toThrow(/exactly one entry/)
  })

  it('throws when there is more than one entry', () => {
    expect(() =>
      findEntryKey({
        'a.js': { file: 'a.js', isEntry: true },
        'b.js': { file: 'b.js', isEntry: true },
      }),
    ).toThrow(/found 2/)
  })
})

describe('collectClosure', () => {
  it('follows static imports and collects their CSS', () => {
    expect(collectClosure(manifest, ['node_modules/nuxt/dist/app/entry.js'])).toEqual({
      scripts: ['entry.js', 'shared.js', 'vue.js'],
      styles: ['entry.css'],
    })
  })

  it('does not follow dynamic imports', () => {
    const { scripts } = collectClosure(manifest, ['node_modules/nuxt/dist/app/entry.js'])
    expect(scripts).not.toContain('a.js')
    expect(scripts).not.toContain('b.js')
  })

  it('walks several roots and deduplicates the overlap', () => {
    expect(
      collectClosure(manifest, ['node_modules/nuxt/dist/app/entry.js', 'pages/a.vue']),
    ).toEqual({
      scripts: ['a.js', 'entry.js', 'heavy.js', 'shared.js', 'vue.js'],
      styles: ['a.css', 'entry.css'],
    })
  })

  it('terminates on a cycle', () => {
    const cyclic: ClientManifest = {
      '_a.js': { file: 'a.js', imports: ['_b.js'] },
      '_b.js': { file: 'b.js', imports: ['_a.js'] },
    }
    expect(collectClosure(cyclic, ['_a.js']).scripts).toEqual(['a.js', 'b.js'])
  })

  it('ignores an import that is not in the manifest', () => {
    expect(
      collectClosure({ '_a.js': { file: 'a.js', imports: ['_gone.js'] } }, ['_a.js']).scripts,
    ).toEqual(['a.js'])
  })

  it('classifies by file extension when the manifest carries no resourceType', () => {
    const raw: ClientManifest = {
      '_a.js': { file: 'a.js', imports: ['style.css'] },
      'style.css': { file: 'style.css' },
    }
    expect(collectClosure(raw, ['_a.js'])).toEqual({ scripts: ['a.js'], styles: [] })
  })
})

describe('buildReport', () => {
  it('splits every route into the shared baseline and its own share', () => {
    const { report, violations } = buildReport(manifest, sizeOf)
    expect(violations).toEqual([])

    // entry + vue + shared + entry.css = 7500 raw, 3750 gzipped.
    expect(report.shared.bytes).toBe(7500)
    expect(report.shared.gzipBytes).toBe(3750)
    expect(report.shared.assets.map((asset) => asset.file)).toEqual([
      'entry.js',
      'shared.js',
      'vue.js',
      'entry.css',
    ])

    const a = report.routes.find((route) => route.route === '/a')
    // /a adds a.js (600), heavy.js (8000) and a.css (200) on top.
    expect(a?.routeOnly.map((asset) => asset.file)).toEqual(['a.js', 'heavy.js', 'a.css'])
    expect(a?.routeOnlyBytes).toBe(8800)
    expect(a?.totalBytes).toBe(16300)
    expect(a?.totalGzipBytes).toBe(8150)
    expect(a?.chunk).toBe('a.js')
    expect(a?.page).toBe('pages/a.vue')
  })

  it('sorts routes by what a visitor waits for, heaviest first', () => {
    const { report } = buildReport(manifest, sizeOf)
    expect(report.routes.map((route) => route.route)).toEqual(['/a', '/b'])
  })

  it('reports a manifest file the build did not write instead of counting it as zero', () => {
    const { violations } = buildReport(manifest, (file) =>
      file === 'heavy.js' ? null : sizeOf(file),
    )
    expect(violations).toHaveLength(1)
    expect(violations[0]?.kind).toBe('manifest')
    expect(violations[0]?.message).toContain('heavy.js')
  })

  it('reports two page chunks that resolve to the same route', () => {
    const clashing: ClientManifest = {
      ...manifest,
      'pages/a/index.vue': {
        file: 'a-index.js',
        src: 'pages/a/index.vue',
        resourceType: 'script',
      },
    }
    const { violations } = buildReport(clashing, (file) =>
      file === 'a-index.js' ? { bytes: 10, gzipBytes: 5 } : sizeOf(file),
    )
    expect(violations.map((violation) => violation.message)).toContain(
      'Two page chunks resolve to the same route `/a`',
    )
  })
})

describe('checkBudgets', () => {
  const { report } = buildReport(manifest, sizeOf)

  const budgets = (overrides: Partial<BudgetConfig> = {}): BudgetConfig => ({
    sharedGzipBytes: 4000,
    routes: {
      '/a': { totalGzipBytes: 9000, routeGzipBytes: 5000 },
      '/b': { totalGzipBytes: 4500, routeGzipBytes: 500 },
    },
    ...overrides,
  })

  it('passes a build that is inside every budget', () => {
    expect(checkBudgets(report, budgets())).toEqual([])
  })

  it('fails a route that is over its total', () => {
    const violations = checkBudgets(
      report,
      budgets({
        routes: {
          '/a': { totalGzipBytes: 8000, routeGzipBytes: 5000 },
          '/b': { totalGzipBytes: 4500, routeGzipBytes: 500 },
        },
      }),
    )
    expect(violations).toHaveLength(1)
    expect(violations[0]?.kind).toBe('over-budget')
    expect(violations[0]?.route).toBe('/a')
    expect(violations[0]?.message).toContain('over its')
  })

  it('fails a route that is over its own share even when the total fits', () => {
    const violations = checkBudgets(
      report,
      budgets({
        routes: {
          '/a': { totalGzipBytes: 9000, routeGzipBytes: 1000 },
          '/b': { totalGzipBytes: 4500, routeGzipBytes: 500 },
        },
      }),
    )
    expect(violations).toHaveLength(1)
    expect(violations[0]?.message).toContain('of its own')
  })

  it('fails the shared baseline separately from the routes that carry it', () => {
    const violations = checkBudgets(report, budgets({ sharedGzipBytes: 1000 }))
    expect(violations).toHaveLength(1)
    expect(violations[0]?.route).toBeNull()
    expect(violations[0]?.message).toContain('Every route pays this')
  })

  it('fails a route with no budget line', () => {
    const violations = checkBudgets(
      report,
      budgets({ routes: { '/b': { totalGzipBytes: 4500, routeGzipBytes: 500 } } }),
    )
    expect(violations).toHaveLength(1)
    expect(violations[0]?.kind).toBe('unbudgeted-route')
    expect(violations[0]?.route).toBe('/a')
  })

  it('fails a budget line with no route behind it', () => {
    const violations = checkBudgets(
      report,
      budgets({
        routes: {
          '/a': { totalGzipBytes: 9000, routeGzipBytes: 5000 },
          '/b': { totalGzipBytes: 4500, routeGzipBytes: 500 },
          '/renamed': { totalGzipBytes: 4500, routeGzipBytes: 500 },
        },
      }),
    )
    expect(violations).toHaveLength(1)
    expect(violations[0]?.kind).toBe('stale-budget')
    expect(violations[0]?.route).toBe('/renamed')
  })
})

describe('checkAgainstDocument', () => {
  const { report } = buildReport(manifest, sizeOf)
  // `report.routes` is sorted heaviest first, and `/a` is the heavier of the two.
  const routeA = report.routes[0]!

  it('passes when the document preloads exactly what was counted', () => {
    expect(
      checkAgainstDocument(routeA, {
        scripts: ['a.js', 'entry.js', 'heavy.js', 'shared.js', 'vue.js'],
        styles: ['a.css', 'entry.css'],
      }),
    ).toEqual([])
  })

  it('fails when the document preloads something that was not counted', () => {
    const violations = checkAgainstDocument(routeA, {
      scripts: ['a.js', 'entry.js', 'heavy.js', 'shared.js', 'vue.js', 'surprise.js'],
      styles: ['a.css', 'entry.css'],
    })
    expect(violations).toHaveLength(1)
    expect(violations[0]?.kind).toBe('model-drift')
    expect(violations[0]?.message).toContain('Preloaded but not counted: surprise.js')
  })

  it('fails when something counted is not in the document', () => {
    const violations = checkAgainstDocument(routeA, {
      scripts: ['a.js', 'entry.js', 'shared.js', 'vue.js'],
      styles: ['a.css', 'entry.css'],
    })
    expect(violations[0]?.message).toContain('Counted but not preloaded: heavy.js')
  })
})

describe('formatting', () => {
  const { report } = buildReport(manifest, sizeOf)
  const budgets: BudgetConfig = {
    sharedGzipBytes: 4000,
    routes: {
      '/a': { totalGzipBytes: 9000, routeGzipBytes: 5000 },
      '/b': { totalGzipBytes: 4500, routeGzipBytes: 500 },
    },
  }

  it('formats bytes the way the payload budget helper does', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(2048)).toBe('2.00 kB')
    expect(formatBytes(2 * 1024 * 1024)).toBe('2.00 MB')
  })

  it('prints one aligned row per route plus the baseline', () => {
    const table = formatReportTable(report, budgets)
    const lines = table.split('\n')
    expect(lines[0]).toContain('Route')
    expect(lines).toHaveLength(6) // header, rule, two routes, blank, baseline
    expect(table).toContain('Shared baseline: 3.66 kB gzipped')
  })

  it('leaves the budget columns blank for a route with no budget', () => {
    const table = formatReportTable(report, { sharedGzipBytes: 4000, routes: {} })
    expect(table).toContain('—')
  })

  it('marks over-budget routes in the Markdown summary', () => {
    const markdown = formatMarkdownSummary(
      report,
      { sharedGzipBytes: 4000, routes: { '/a': { totalGzipBytes: 10, routeGzipBytes: 10 } } },
      checkBudgets(report, { sharedGzipBytes: 4000, routes: {} }),
    )
    expect(markdown).toContain('| `/a` |')
    expect(markdown).toContain('❌')
    expect(markdown).toContain('### Violations')
  })

  it('says so plainly when there is nothing to report', () => {
    const markdown = formatMarkdownSummary(report, budgets, [])
    expect(markdown).toContain('All routes are within budget.')
    expect(markdown).not.toContain('❌')
  })
})
