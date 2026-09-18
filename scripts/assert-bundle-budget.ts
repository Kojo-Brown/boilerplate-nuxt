/**
 * Fails the build when a route ships more JavaScript than it is budgeted, and
 * prints what every route actually costs.
 *
 * `nuxt build` prints one number for the client bundle — the total — and it is
 * the least useful number available. A Nuxt application does not load its total
 * on any route; it loads the entry chunk, the chunk for the page being
 * rendered, and the static imports of both. That per-route figure is the one a
 * visitor waits for, and nothing in the toolchain reports it, so a component
 * that quietly pulls a date library into the shared closure looks identical in
 * CI to one that does not.
 *
 * The measurement, and where it can be wrong:
 *
 *  1. **Gzip, not raw bytes.** Raw size is what a minifier reports; gzip is
 *     what crosses the wire, and the two move independently — generated code
 *     that adds 30 kB raw can add 2 kB gzipped. Brotli would be closer still
 *     for a CDN-served deployment, but gzip is in every Node the CI matrix
 *     runs and is the conservative of the two.
 *
 *  2. **Static imports only.** See the header of `scripts/bundleBudget.ts` for
 *     what that includes and what it deliberately leaves out.
 *
 *  3. **The model is checked against a real document.** `/route-rules/static`
 *     is prerendered, so the build writes an HTML file listing exactly what it
 *     preloads. Every run diffs the computed asset set against that list and
 *     fails on a mismatch, which is what stops this gate from reporting
 *     confident numbers about a manifest walk that a Nuxt upgrade has made
 *     obsolete.
 *
 *  4. **Budgets are measured, not guessed.** Each number in
 *     `bundle-budget.config.ts` is the route's real size plus roughly 5%.
 *     Tighter and the gate fails on compressor differences between Node
 *     majors; looser and a route can absorb a library before anyone hears
 *     about it. Raising one is a one-line diff that reads in review as what it
 *     is — a decision to ship more JavaScript.
 *
 * Usage: `pnpm bundle:budget [path-to-project-root]`, after `pnpm build`.
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { gzipSync } from 'node:zlib'

import { bundleBudgets, CLIENT_MANIFEST_PATH, REPORT_PATH } from '../bundle-budget.config.ts'
import {
  buildReport,
  checkAgainstDocument,
  checkBudgets,
  formatMarkdownSummary,
  formatReportTable,
  type BudgetConfig,
  type BundleReport,
  type ClientManifest,
  type Violation,
} from './bundleBudget.ts'

/** Where the built client assets live, relative to the project root. */
const CLIENT_ASSET_DIR = '.output/public/_nuxt'

/** Nuxt's build metadata, which records what was prerendered. */
const BUILD_META_DIR = '.output/public/_nuxt/builds'

export interface BundleBudgetResult {
  readonly report: BundleReport
  readonly violations: readonly Violation[]
  /** Routes whose computed payload was checked against a rendered document. */
  readonly verifiedRoutes: readonly string[]
}

/**
 * Reads a finished build and measures it. Pure enough to test: everything it
 * touches is under `rootDir`, and it neither prints nor exits.
 */
export function runBundleBudget(rootDir: string, budgets: BudgetConfig): BundleBudgetResult {
  const manifestPath = join(rootDir, CLIENT_MANIFEST_PATH)
  if (!existsSync(manifestPath)) {
    throw new Error(
      `No client manifest at ${manifestPath}. Run \`pnpm build\` first — ` +
        `modules/bundle-budget.ts writes it during the client build.`,
    )
  }

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as ClientManifest
  const assetDir = join(rootDir, CLIENT_ASSET_DIR)
  if (!existsSync(assetDir)) {
    throw new Error(
      `No client assets at ${assetDir}. The manifest and the build output must come ` +
        `from the same \`pnpm build\`.`,
    )
  }

  const { report, violations } = buildReport(manifest, sizer(assetDir))
  const budgetViolations = checkBudgets(report, budgets)

  const { violations: driftViolations, verifiedRoutes } = checkPrerenderedDocuments(rootDir, report)

  return {
    report,
    violations: [...violations, ...driftViolations, ...budgetViolations],
    verifiedRoutes,
  }
}

/** Stats and gzips each file once, memoised for the whole run. */
function sizer(assetDir: string): (file: string) => { bytes: number; gzipBytes: number } | null {
  const cache = new Map<string, { bytes: number; gzipBytes: number } | null>()

  return (file) => {
    const cached = cache.get(file)
    if (cached !== undefined) return cached

    const path = join(assetDir, file)
    let size: { bytes: number; gzipBytes: number } | null = null
    if (existsSync(path)) {
      const contents = readFileSync(path)
      // Default compression level, which is what a server or CDN applies by
      // default too. Level 9 would report a size nobody actually serves.
      size = { bytes: contents.byteLength, gzipBytes: gzipSync(contents).byteLength }
    }

    cache.set(file, size)
    return size
  }
}

/**
 * Cross-checks the computed payload against every document the build
 * prerendered.
 *
 * Returns no violations when nothing was prerendered — that is a legitimate
 * configuration, and the caller says so in its output rather than letting an
 * unverified model pass as a verified one.
 */
function checkPrerenderedDocuments(
  rootDir: string,
  report: BundleReport,
): { violations: Violation[]; verifiedRoutes: string[] } {
  const violations: Violation[] = []
  const verifiedRoutes: string[] = []

  for (const path of prerenderedPaths(rootDir)) {
    const route = report.routes.find((candidate) => candidate.route === path)
    // A prerendered path with no matching route pattern is a dynamic route's
    // rendered instance (`/blog/[slug]` prerendered as `/blog/hello`). There is
    // nothing to diff it against, and it is not a failure.
    if (!route) continue

    const documentPath = join(rootDir, '.output/public', path.replace(/^\//, ''), 'index.html')
    if (!existsSync(documentPath)) continue

    violations.push(
      ...checkAgainstDocument(route, parseDocumentAssets(readFileSync(documentPath, 'utf8'))),
    )
    verifiedRoutes.push(route.route)
  }

  return { violations, verifiedRoutes }
}

/** Paths Nitro prerendered, from the build metadata it writes. */
function prerenderedPaths(rootDir: string): string[] {
  const metaDir = join(rootDir, BUILD_META_DIR, 'meta')
  if (!existsSync(metaDir)) return []

  const paths = new Set<string>()
  for (const file of readdirSync(metaDir)) {
    if (!file.endsWith('.json')) continue
    const meta = JSON.parse(readFileSync(join(metaDir, file), 'utf8')) as {
      prerendered?: string[]
    }
    for (const path of meta.prerendered ?? []) paths.add(path)
  }

  return [...paths].sort()
}

/**
 * The assets a rendered document tells the browser to fetch *now*.
 *
 * `rel="prefetch"` links are excluded on purpose: those are the other routes'
 * chunks, fetched at idle priority after the page is interactive, and counting
 * them would put the whole application in every route's number.
 */
export function parseDocumentAssets(html: string): { scripts: string[]; styles: string[] } {
  const scripts = new Set<string>()
  const styles = new Set<string>()

  for (const [tag] of html.matchAll(/<link\b[^>]*>/g)) {
    const rel = /\brel="?([\w-]+)"?/.exec(tag)?.[1]
    const href = /\bhref="([^"]+)"/.exec(tag)?.[1]
    if (!rel || !href) continue

    const file = /^\/_nuxt\/([^?#]+)(?:[?#].*)?$/.exec(href)?.[1]
    if (!file) continue

    if (rel === 'modulepreload') scripts.add(file)
    if (rel === 'stylesheet') styles.add(file)
  }

  return { scripts: [...scripts].sort(), styles: [...styles].sort() }
}

/** stdout without `console`, which this repo's lint config reserves for warnings. */
function write(line: string): void {
  process.stdout.write(`${line}\n`)
}

function main(): void {
  const rootDir = process.argv[2] ?? process.cwd()
  const budgets = bundleBudgets

  const { report, violations, verifiedRoutes } = runBundleBudget(rootDir, budgets)

  write(formatReportTable(report, budgets))
  write('')
  write(
    verifiedRoutes.length > 0
      ? `Model checked against the prerendered document${verifiedRoutes.length > 1 ? 's' : ''} for ` +
          `${verifiedRoutes.join(', ')}.`
      : 'No prerendered document to check the model against — sizes are computed from the ' +
          'manifest alone.',
  )

  const reportPath = join(rootDir, REPORT_PATH)
  mkdirSync(dirname(reportPath), { recursive: true })
  writeFileSync(
    reportPath,
    `${JSON.stringify({ generatedAt: new Date().toISOString(), report, violations }, null, 2)}\n`,
    'utf8',
  )
  write(`Report written to ${reportPath}`)

  const summaryPath = process.env.GITHUB_STEP_SUMMARY
  if (summaryPath) {
    appendFileSync(summaryPath, formatMarkdownSummary(report, budgets, violations), 'utf8')
  }

  if (violations.length === 0) {
    write('')
    write('Every route is within budget.')
    return
  }

  process.stderr.write(`\n${violations.length} bundle budget violation(s):\n`)
  for (const violation of violations) {
    process.stderr.write(`  [${violation.kind}] ${violation.message}\n`)
  }
  process.exitCode = 1
}

// `import.meta.main` is Node 24+; the comparison covers Node 22.
if (import.meta.url === `file://${process.argv[1]}`) {
  main()
}
