import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { gzipSync } from 'node:zlib'

import { afterEach, describe, it, expect } from 'vitest'

import { CLIENT_MANIFEST_PATH } from '../../../bundle-budget.config'
import { parseDocumentAssets, runBundleBudget } from '../../../scripts/assert-bundle-budget'
import type { BudgetConfig, ClientManifest } from '../../../scripts/bundleBudget'

/**
 * These tests drive the gate the way CI does — against a directory laid out
 * like a finished `nuxt build` — because the parts that can only break at that
 * level are the parts that read the filesystem: where the manifest is looked
 * for, which files are gzipped, and whether the prerendered document is found
 * and diffed. `bundleBudget.test.ts` covers the arithmetic.
 */

const manifest: ClientManifest = {
  'node_modules/nuxt/dist/app/entry.js': {
    file: 'entry.js',
    src: 'node_modules/nuxt/dist/app/entry.js',
    resourceType: 'script',
    isEntry: true,
    imports: ['_shared.js'],
    dynamicImports: ['pages/docs.vue'],
    css: ['entry.css'],
  },
  '_shared.js': { file: 'shared.js', resourceType: 'script' },
  'pages/docs.vue': {
    file: 'docs.js',
    src: 'pages/docs.vue',
    resourceType: 'script',
    isDynamicEntry: true,
    imports: ['_shared.js'],
  },
  'entry.css': { file: 'entry.css', resourceType: 'style' },
}

/** Compressible filler, so gzipped size is meaningfully below raw size. */
const filler = (bytes: number): string => 'a'.repeat(bytes)

const files: Record<string, string> = {
  'entry.js': filler(4000),
  'shared.js': filler(2000),
  'docs.js': filler(1000),
  'entry.css': filler(500),
}

const document = `<!DOCTYPE html><html><head>
<link rel="stylesheet" href="/_nuxt/entry.css" crossorigin>
<link rel="preload" as="fetch" crossorigin="anonymous" href="/docs/_payload.json?_b=abc">
<link rel="modulepreload" as="script" crossorigin href="/_nuxt/entry.js">
<link rel="modulepreload" as="script" crossorigin href="/_nuxt/shared.js">
<link rel="modulepreload" as="script" crossorigin href="/_nuxt/docs.js">
<link rel="prefetch" as="script" crossorigin href="/_nuxt/other-page.js">
</head><body></body></html>`

const budgets: BudgetConfig = {
  sharedGzipBytes: 1024,
  routes: { '/docs': { totalGzipBytes: 1024, routeGzipBytes: 512 } },
}

const roots: string[] = []

function buildFixture(
  options: {
    manifest?: ClientManifest
    prerendered?: string[]
    document?: string
    omitManifest?: boolean
  } = {},
): string {
  const root = mkdtempSync(join(tmpdir(), 'bundle-budget-'))
  roots.push(root)

  if (!options.omitManifest) {
    write(join(root, CLIENT_MANIFEST_PATH), JSON.stringify(options.manifest ?? manifest))
  }

  for (const [name, contents] of Object.entries(files)) {
    write(join(root, '.output/public/_nuxt', name), contents)
  }

  write(
    join(root, '.output/public/_nuxt/builds/meta/00000000-0000-4000-8000-000000000000.json'),
    JSON.stringify({ id: 'test', timestamp: 0, prerendered: options.prerendered ?? [] }),
  )

  for (const path of options.prerendered ?? []) {
    write(
      join(root, '.output/public', path.replace(/^\//, ''), 'index.html'),
      options.document ?? document,
    )
  }

  return root
}

function write(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, contents, 'utf8')
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('runBundleBudget', () => {
  it('measures the real gzipped size of the files the build wrote', () => {
    const { report } = runBundleBudget(buildFixture(), budgets)

    const expectedShared =
      gzipSync(files['entry.js'] ?? '').byteLength +
      gzipSync(files['shared.js'] ?? '').byteLength +
      gzipSync(files['entry.css'] ?? '').byteLength

    expect(report.shared.bytes).toBe(6500)
    expect(report.shared.gzipBytes).toBe(expectedShared)

    const docs = report.routes.find((route) => route.route === '/docs')
    expect(docs?.routeOnly.map((asset) => asset.file)).toEqual(['docs.js'])
    expect(docs?.routeOnlyGzipBytes).toBe(gzipSync(files['docs.js'] ?? '').byteLength)
  })

  it('passes a build inside its budgets and reports no verified route when nothing is prerendered', () => {
    const { violations, verifiedRoutes } = runBundleBudget(buildFixture(), budgets)
    expect(violations).toEqual([])
    expect(verifiedRoutes).toEqual([])
  })

  it('verifies the computed payload against a prerendered document', () => {
    const { violations, verifiedRoutes } = runBundleBudget(
      buildFixture({ prerendered: ['/docs'] }),
      budgets,
    )
    expect(violations).toEqual([])
    expect(verifiedRoutes).toEqual(['/docs'])
  })

  it('fails when the document preloads a chunk the manifest walk missed', () => {
    const root = buildFixture({
      prerendered: ['/docs'],
      document: document.replace(
        '</head>',
        '<link rel="modulepreload" as="script" crossorigin href="/_nuxt/mystery.js"></head>',
      ),
    })

    const { violations } = runBundleBudget(root, budgets)
    expect(violations.map((violation) => violation.kind)).toContain('model-drift')
    expect(violations[0]?.message).toContain('mystery.js')
  })

  it('ignores a prerendered path that belongs to a dynamic route', () => {
    const { violations, verifiedRoutes } = runBundleBudget(
      buildFixture({ prerendered: ['/docs/rendered-instance'] }),
      budgets,
    )
    expect(violations).toEqual([])
    expect(verifiedRoutes).toEqual([])
  })

  it('reports a manifest entry with no file on disk', () => {
    const { violations } = runBundleBudget(
      buildFixture({
        manifest: { ...manifest, '_gone.js': { file: 'gone.js', resourceType: 'script' } },
      }),
      budgets,
    )
    // The orphan chunk is only counted if something imports it; make sure the
    // check fires when it is reachable.
    expect(violations).toEqual([])

    const { violations: reachable } = runBundleBudget(
      buildFixture({
        manifest: {
          ...manifest,
          '_shared.js': { file: 'shared.js', resourceType: 'script', imports: ['_gone.js'] },
          '_gone.js': { file: 'gone.js', resourceType: 'script' },
        },
      }),
      budgets,
    )
    expect(reachable.some((violation) => violation.kind === 'manifest')).toBe(true)
  })

  it('explains what to run when the manifest is missing', () => {
    expect(() => runBundleBudget(buildFixture({ omitManifest: true }), budgets)).toThrow(
      /No client manifest at .*Run `pnpm build` first/s,
    )
  })
})

describe('parseDocumentAssets', () => {
  it('takes what the document loads now and leaves what it prefetches', () => {
    expect(parseDocumentAssets(document)).toEqual({
      scripts: ['docs.js', 'entry.js', 'shared.js'],
      styles: ['entry.css'],
    })
  })

  it('ignores links to anything outside /_nuxt/', () => {
    expect(
      parseDocumentAssets('<link rel="modulepreload" href="https://cdn.example.com/x.js">'),
    ).toEqual({ scripts: [], styles: [] })
  })

  it('reads rel and href regardless of attribute order or quoting', () => {
    expect(
      parseDocumentAssets('<link crossorigin href="/_nuxt/x.js" as=script rel=modulepreload>'),
    ).toEqual({ scripts: ['x.js'], styles: [] })
  })

  it('strips a query string so the file matches the manifest entry', () => {
    expect(parseDocumentAssets('<link rel="stylesheet" href="/_nuxt/a.css?v=2">')).toEqual({
      scripts: [],
      styles: ['a.css'],
    })
  })
})
