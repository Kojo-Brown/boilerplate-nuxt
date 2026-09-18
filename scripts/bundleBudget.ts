/**
 * Turning Nuxt's client manifest into a per-route payload report.
 *
 * Everything in this module is pure: it takes a manifest and a function that
 * reports the size of a built file, and returns numbers. The filesystem, the
 * gzip calls, the exit code and the printing all live in
 * `scripts/assert-bundle-budget.ts`, which is what CI runs.
 *
 * ## What "a route's payload" means here
 *
 * When Nuxt server-renders `/upload`, the document it returns carries a
 * `<link rel="modulepreload">` for the app entry chunk, one for the page's own
 * chunk, and one for every chunk those two *statically* import, plus a
 * `<link rel="stylesheet">` for the CSS attached to any of them. That set is
 * what the browser downloads before it can hydrate, and it is what this module
 * measures.
 *
 * Three things are deliberately *not* in it:
 *
 *  - **Dynamic imports.** The entry chunk dynamically imports every page and
 *    both locale files; Nuxt emits those as `rel="prefetch"`, which browsers
 *    fetch at idle and which no visitor waits for. Counting them would give
 *    every route the same number — the whole application — and the report would
 *    say nothing about the route.
 *  - **Server islands and lazy components.** Same reason, same mechanism: an
 *    island's chunk is fetched by the island endpoint, not by the document.
 *  - **The payload `__NUXT__` blob.** That is per-request data rather than
 *    build output, so it cannot be measured from a manifest. It has its own
 *    tooling in `utils/payloadBudget.ts`.
 *
 * ## Why the manifest rather than the rendered HTML
 *
 * Reading the documents the build wrote would be more direct, but this app
 * prerenders exactly one route (`/route-rules/static`) — every other page is
 * rendered per request and most sit behind `middleware/auth.global.ts`, so a
 * crawl would measure the login redirect instead of the page. The manifest is
 * the same graph Nuxt's renderer walks to emit those preload links, so the
 * model is not an approximation of the renderer; it is the renderer's own
 * input. `assert-bundle-budget.ts` proves that on every run by diffing the
 * computed asset set for the one prerendered route against the links in the
 * document Nuxt actually wrote.
 */

/** One entry in the client manifest Nuxt passes to the `build:manifest` hook. */
export interface ManifestChunk {
  /** Path of the emitted file, relative to `/_nuxt/`. */
  readonly file: string
  /** Source module, e.g. `pages/upload.vue`. Absent for shared chunks. */
  readonly src?: string
  /** `'script'` or `'style'` — Nuxt sets this; Vite's raw manifest does not. */
  readonly resourceType?: string
  /** Statically imported manifest keys. These load with the chunk. */
  readonly imports?: readonly string[]
  /** Lazily imported manifest keys. These do not. */
  readonly dynamicImports?: readonly string[]
  /** Stylesheets the chunk pulls in, as file names relative to `/_nuxt/`. */
  readonly css?: readonly string[]
  readonly isEntry?: boolean
  readonly isDynamicEntry?: boolean
}

/** The manifest as a whole, keyed by module id or by `_<chunk>.js`. */
export type ClientManifest = Readonly<Record<string, ManifestChunk>>

/** A built file with both of the sizes that matter. */
export interface AssetSize {
  /** File name relative to `/_nuxt/`, e.g. `B3mwCiyu.js`. */
  readonly file: string
  readonly bytes: number
  /** Gzipped size — what actually crosses the wire. */
  readonly gzipBytes: number
}

/** Everything one route makes a browser download before hydration. */
export interface RoutePayload {
  /** Route path in Nuxt's own notation, e.g. `/rendering/isr`, `/users/:id()`. */
  readonly route: string
  /** Page component that serves it, e.g. `pages/rendering/isr.vue`. */
  readonly page: string
  /** The page's own chunk, relative to `/_nuxt/`. */
  readonly chunk: string
  /** Every asset the document preloads: the shared baseline plus this route's. */
  readonly assets: readonly AssetSize[]
  /** The subset a visitor pays *because they landed on this route*. */
  readonly routeOnly: readonly AssetSize[]
  readonly totalBytes: number
  readonly totalGzipBytes: number
  readonly routeOnlyBytes: number
  readonly routeOnlyGzipBytes: number
}

/** The assets every route loads, whichever one the visitor lands on. */
export interface SharedBaseline {
  readonly assets: readonly AssetSize[]
  readonly bytes: number
  readonly gzipBytes: number
}

export interface BundleReport {
  readonly shared: SharedBaseline
  /** One entry per page, largest total first. */
  readonly routes: readonly RoutePayload[]
}

/** A per-route ceiling. Both numbers are gzipped bytes. */
export interface RouteBudget {
  /** Ceiling for the whole initial payload: shared baseline plus route. */
  readonly totalGzipBytes: number
  /** Ceiling for what the route adds on top of the shared baseline. */
  readonly routeGzipBytes: number
}

export interface BudgetConfig {
  /** Ceiling for the assets every route pays, in gzipped bytes. */
  readonly sharedGzipBytes: number
  /** One entry per route. A route missing from this table fails the gate. */
  readonly routes: Readonly<Record<string, RouteBudget>>
}

export type ViolationKind =
  /** A measured size exceeds its budget. */
  | 'over-budget'
  /** The build has a route the budget table does not mention. */
  | 'unbudgeted-route'
  /** The budget table names a route the build does not have. */
  | 'stale-budget'
  /** The computed asset set disagrees with a document Nuxt actually wrote. */
  | 'model-drift'
  /** The manifest is not shaped the way this tool assumes. */
  | 'manifest'

export interface Violation {
  readonly kind: ViolationKind
  /** Route the violation is about, or `null` for whole-build problems. */
  readonly route: string | null
  readonly message: string
}

/**
 * Chunk keys for pages, in manifest order.
 *
 * A page chunk is recognised by its `src`, not by its key: Vite keys entries by
 * module id for source modules and by `_<file>` for shared chunks, so matching
 * on the key alone would also pick up a shared chunk that happens to be named
 * after a page.
 */
export function pageChunkKeys(manifest: ClientManifest): string[] {
  return Object.keys(manifest).filter((key) => {
    const src = manifest[key]?.src
    return src !== undefined && isPageSource(src)
  })
}

function isPageSource(src: string): boolean {
  return /(^|\/)pages\/.+\.vue$/.test(src) && !src.includes('node_modules')
}

/**
 * The single entry chunk — Nuxt's `app/entry.js`.
 *
 * Throws rather than guessing. Every route's number is measured relative to
 * this chunk's closure, so picking the wrong one would not fail loudly; it
 * would quietly move bytes between the "shared" and "route" columns.
 */
export function findEntryKey(manifest: ClientManifest): string {
  const entries = Object.keys(manifest).filter((key) => manifest[key]?.isEntry)
  if (entries.length !== 1) {
    throw new Error(
      `Expected exactly one entry chunk in the client manifest, found ${entries.length}` +
        (entries.length > 0 ? `: ${entries.join(', ')}` : ''),
    )
  }
  // `entries[0]` is defined — length was just checked — but
  // `noUncheckedIndexedAccess` types it as possibly undefined.
  return entries[0] as string
}

/**
 * Files reachable from `keys` through *static* imports only, plus their CSS.
 *
 * Returned sorted so two closures can be compared and diffed without the walk
 * order mattering.
 */
export function collectClosure(
  manifest: ClientManifest,
  keys: readonly string[],
): { scripts: string[]; styles: string[] } {
  const seen = new Set<string>()
  const scripts = new Set<string>()
  const styles = new Set<string>()

  const walk = (key: string): void => {
    if (seen.has(key)) return
    seen.add(key)

    const chunk = manifest[key]
    if (!chunk) return

    if (isScript(chunk)) scripts.add(chunk.file)
    for (const style of chunk.css ?? []) styles.add(style)
    for (const imported of chunk.imports ?? []) walk(imported)
  }

  for (const key of keys) walk(key)

  return { scripts: [...scripts].sort(), styles: [...styles].sort() }
}

function isScript(chunk: ManifestChunk): boolean {
  if (chunk.resourceType !== undefined) return chunk.resourceType === 'script'
  return chunk.file.endsWith('.js') || chunk.file.endsWith('.mjs')
}

/**
 * Route path for a page component, following Nuxt's file-based routing.
 *
 * Reported in Nuxt's own notation (`:id()`, not `:id`) so a line in the report
 * can be matched against the route table `nuxt build` prints without anyone
 * having to translate between two spellings.
 *
 * Localised routes are deliberately not enumerated. `@nuxtjs/i18n` is
 * configured with `strategy: 'prefix_except_default'`, so `/fr/upload` exists
 * and serves the same page component — and therefore the same chunks — as
 * `/upload`. Listing both would double every line of the report without
 * measuring anything new.
 */
export function routePathFromPageSource(src: string): string {
  const withoutPrefix = src.replace(/^.*?(^|\/)pages\//, '').replace(/\.vue$/, '')

  const segments = withoutPrefix
    .split('/')
    .map((segment) => routeSegment(segment))
    .filter((segment) => segment !== '')

  return `/${segments.join('/')}`
}

function routeSegment(segment: string): string {
  // `index` names the parent path itself, and only as a whole segment:
  // `pages/rendering/index.vue` is `/rendering`, while `pages/index-cards.vue`
  // is `/index-cards`.
  if (segment === 'index') return ''

  // `[[id]]` → optional param, `[...slug]` → catch-all, `[id]` → param.
  // Nested inside a longer segment too: `user-[id]` → `user-:id()`.
  return segment
    .replace(/\[\[\.\.\.(\w+)\]\]/g, ':$1(.*)*')
    .replace(/\[\.\.\.(\w+)\]/g, ':$1(.*)*')
    .replace(/\[\[(\w+)\]\]/g, ':$1?')
    .replace(/\[(\w+)\]/g, ':$1()')
}

/**
 * The full report: the shared baseline, and every route measured against it.
 *
 * `sizeOf` is injected so this stays pure — `assert-bundle-budget.ts` passes
 * one that stats and gzips the real files, and the tests pass one that returns
 * fixture numbers. It returns `null` for a file the build did not write, which
 * is reported as a manifest violation rather than silently counted as zero.
 */
export function buildReport(
  manifest: ClientManifest,
  sizeOf: (file: string) => { bytes: number; gzipBytes: number } | null,
): { report: BundleReport; violations: Violation[] } {
  const violations: Violation[] = []
  const entryKey = findEntryKey(manifest)

  const measure = (file: string): AssetSize => {
    const size = sizeOf(file)
    if (size === null) {
      violations.push({
        kind: 'manifest',
        route: null,
        message: `Manifest names \`${file}\`, which the build did not write`,
      })
      return { file, bytes: 0, gzipBytes: 0 }
    }
    return { file, bytes: size.bytes, gzipBytes: size.gzipBytes }
  }

  const sharedClosure = collectClosure(manifest, [entryKey])
  const sharedFiles = [...sharedClosure.scripts, ...sharedClosure.styles]
  const sharedAssets = sharedFiles.map(measure)
  const sharedSet = new Set(sharedFiles)

  const routes = pageChunkKeys(manifest)
    .map((key): RoutePayload => {
      // `pageChunkKeys` only returns keys whose chunk has a `src`.
      const chunk = manifest[key] as ManifestChunk
      const closure = collectClosure(manifest, [entryKey, key])
      const files = [...closure.scripts, ...closure.styles]
      const assets = files.map(measure)
      const routeOnly = assets.filter((asset) => !sharedSet.has(asset.file))

      return {
        route: routePathFromPageSource(chunk.src as string),
        page: chunk.src as string,
        chunk: chunk.file,
        assets,
        routeOnly,
        totalBytes: sum(assets, 'bytes'),
        totalGzipBytes: sum(assets, 'gzipBytes'),
        routeOnlyBytes: sum(routeOnly, 'bytes'),
        routeOnlyGzipBytes: sum(routeOnly, 'gzipBytes'),
      }
    })
    .sort((a, b) => b.totalGzipBytes - a.totalGzipBytes || a.route.localeCompare(b.route))

  const duplicates = routes
    .map((route) => route.route)
    .filter((route, index, all) => all.indexOf(route) !== index)
  for (const route of new Set(duplicates)) {
    violations.push({
      kind: 'manifest',
      route,
      message: `Two page chunks resolve to the same route \`${route}\``,
    })
  }

  return {
    report: {
      shared: {
        assets: sharedAssets,
        bytes: sum(sharedAssets, 'bytes'),
        gzipBytes: sum(sharedAssets, 'gzipBytes'),
      },
      routes,
    },
    violations,
  }
}

function sum(assets: readonly AssetSize[], key: 'bytes' | 'gzipBytes'): number {
  return assets.reduce((total, asset) => total + asset[key], 0)
}

/**
 * Compares a report against the budget table.
 *
 * A route the table does not mention fails, and so does a table entry with no
 * route behind it. Both are the same failure in different directions: the table
 * is meant to be a complete, current list of what this application ships, and a
 * budget that silently stops applying — because a page was renamed — is worse
 * than no budget, since it still reads like coverage.
 */
export function checkBudgets(report: BundleReport, budgets: BudgetConfig): Violation[] {
  const violations: Violation[] = []

  if (report.shared.gzipBytes > budgets.sharedGzipBytes) {
    violations.push({
      kind: 'over-budget',
      route: null,
      message:
        `Shared baseline is ${formatBytes(report.shared.gzipBytes)} gzipped, ` +
        `over its ${formatBytes(budgets.sharedGzipBytes)} budget by ` +
        `${formatBytes(report.shared.gzipBytes - budgets.sharedGzipBytes)}. ` +
        `Every route pays this.`,
    })
  }

  for (const route of report.routes) {
    const budget = budgets.routes[route.route]
    if (!budget) {
      violations.push({
        kind: 'unbudgeted-route',
        route: route.route,
        message:
          `\`${route.route}\` (${route.page}) has no entry in bundle-budget.config.ts. ` +
          `It costs ${formatBytes(route.totalGzipBytes)} gzipped ` +
          `(${formatBytes(route.routeOnlyGzipBytes)} of it its own).`,
      })
      continue
    }

    if (route.totalGzipBytes > budget.totalGzipBytes) {
      violations.push({
        kind: 'over-budget',
        route: route.route,
        message:
          `\`${route.route}\` loads ${formatBytes(route.totalGzipBytes)} gzipped, ` +
          `over its ${formatBytes(budget.totalGzipBytes)} budget by ` +
          `${formatBytes(route.totalGzipBytes - budget.totalGzipBytes)}.`,
      })
    }

    if (route.routeOnlyGzipBytes > budget.routeGzipBytes) {
      violations.push({
        kind: 'over-budget',
        route: route.route,
        message:
          `\`${route.route}\` adds ${formatBytes(route.routeOnlyGzipBytes)} gzipped of its own, ` +
          `over its ${formatBytes(budget.routeGzipBytes)} budget by ` +
          `${formatBytes(route.routeOnlyGzipBytes - budget.routeGzipBytes)}.`,
      })
    }
  }

  const built = new Set(report.routes.map((route) => route.route))
  for (const route of Object.keys(budgets.routes)) {
    if (!built.has(route)) {
      violations.push({
        kind: 'stale-budget',
        route,
        message:
          `bundle-budget.config.ts budgets \`${route}\`, which this build does not serve. ` +
          `Remove the entry, or fix the route it was meant to cover.`,
      })
    }
  }

  return violations
}

/**
 * Diffs the computed asset set for one route against a document Nuxt wrote.
 *
 * This is the check that keeps the model honest. Everything else in this file
 * assumes that "entry closure plus page closure" is what a Nuxt document
 * preloads; if a Nuxt upgrade changes how the renderer walks the manifest, that
 * assumption becomes wrong silently and every number in the report drifts with
 * it. Comparing against a real prerendered document turns that into a failure.
 */
export function checkAgainstDocument(
  route: RoutePayload,
  document: { readonly scripts: readonly string[]; readonly styles: readonly string[] },
): Violation[] {
  const computed = new Set(route.assets.map((asset) => asset.file))
  const rendered = new Set([...document.scripts, ...document.styles])

  const missing = [...rendered].filter((file) => !computed.has(file)).sort()
  const extra = [...computed].filter((file) => !rendered.has(file)).sort()

  if (missing.length === 0 && extra.length === 0) return []

  return [
    {
      kind: 'model-drift',
      route: route.route,
      message:
        `The computed payload for \`${route.route}\` does not match the document the build ` +
        `wrote for it. ` +
        (missing.length > 0 ? `Preloaded but not counted: ${missing.join(', ')}. ` : '') +
        (extra.length > 0 ? `Counted but not preloaded: ${extra.join(', ')}. ` : '') +
        `The manifest walk in scripts/bundleBudget.ts no longer matches Nuxt's renderer.`,
    },
  ]
}

/** Human-readable bytes. Mirrors `utils/payloadBudget.ts` so reports agree. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return 'unknown'
  if (Math.abs(bytes) < 1024) return `${Math.round(bytes)} B`
  const kb = bytes / 1024
  if (Math.abs(kb) < 1024) return `${kb.toFixed(kb < 10 ? 2 : 1)} kB`
  return `${(kb / 1024).toFixed(2)} MB`
}

/** A fixed-width table for a build log. */
export function formatReportTable(report: BundleReport, budgets: BudgetConfig): string {
  const header = ['Route', 'Total gzip', 'Budget', 'Route-only gzip', 'Budget', 'Raw total']
  const rows = report.routes.map((route) => {
    const budget = budgets.routes[route.route]
    return [
      route.route,
      formatBytes(route.totalGzipBytes),
      budget ? formatBytes(budget.totalGzipBytes) : '—',
      formatBytes(route.routeOnlyGzipBytes),
      budget ? formatBytes(budget.routeGzipBytes) : '—',
      formatBytes(route.totalBytes),
    ]
  })

  const widths = header.map((_, column) =>
    Math.max(header[column]?.length ?? 0, ...rows.map((row) => row[column]?.length ?? 0)),
  )
  const line = (cells: readonly string[]): string =>
    cells
      .map((cell, column) =>
        column === 0 ? cell.padEnd(widths[column] ?? 0) : cell.padStart(widths[column] ?? 0),
      )
      .join('  ')
      .trimEnd()

  return [
    line(header),
    widths.map((width) => '─'.repeat(width)).join('  '),
    ...rows.map(line),
    '',
    `Shared baseline: ${formatBytes(report.shared.gzipBytes)} gzipped ` +
      `(${formatBytes(report.shared.bytes)} raw) across ${report.shared.assets.length} files, ` +
      `budget ${formatBytes(budgets.sharedGzipBytes)}`,
  ].join('\n')
}

/** The same table as GitHub-flavoured Markdown, for the job summary. */
export function formatMarkdownSummary(
  report: BundleReport,
  budgets: BudgetConfig,
  violations: readonly Violation[],
): string {
  const rows = report.routes.map((route) => {
    const budget = budgets.routes[route.route]
    const over = budget !== undefined && route.totalGzipBytes > budget.totalGzipBytes
    return (
      `| \`${route.route}\` | ${formatBytes(route.totalGzipBytes)} | ` +
      `${budget ? formatBytes(budget.totalGzipBytes) : '—'} | ` +
      `${formatBytes(route.routeOnlyGzipBytes)} | ` +
      `${budget ? formatBytes(budget.routeGzipBytes) : '—'} | ` +
      `${over ? '❌' : '✅'} |`
    )
  })

  return [
    '## Per-route payload',
    '',
    `Shared baseline: **${formatBytes(report.shared.gzipBytes)}** gzipped ` +
      `(${report.shared.assets.length} files, budget ${formatBytes(budgets.sharedGzipBytes)}).`,
    '',
    '| Route | Total gzip | Budget | Route-only gzip | Budget | |',
    '| --- | ---: | ---: | ---: | ---: | :-: |',
    ...rows,
    '',
    ...(violations.length === 0
      ? ['All routes are within budget.']
      : ['### Violations', '', ...violations.map((violation) => `- ${violation.message}`)]),
    '',
  ].join('\n')
}
