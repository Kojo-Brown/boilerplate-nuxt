import { readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, it, expect } from 'vitest'

import { bundleBudgets } from '../../bundle-budget.config'
import { routePathFromPageSource } from '../../scripts/bundleBudget'

/**
 * The budget table has to list every route and nothing else, and
 * `scripts/assert-bundle-budget.ts` enforces that — but only in the build job,
 * after a full `nuxt build`. This test enforces the same thing against
 * `pages/`, so adding a page without budgeting it fails in `pnpm test` in
 * seconds rather than several minutes into CI.
 *
 * It cannot check the *numbers*; those need a build. It checks the shape, which
 * is the half that goes wrong by omission.
 */

const root = fileURLToPath(new URL('../..', import.meta.url))
const pagesDir = join(root, 'pages')

function pageSources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return pageSources(path)
    return entry.name.endsWith('.vue') ? [relative(root, path)] : []
  })
}

const routes = pageSources(pagesDir).map((source) => routePathFromPageSource(source))

describe('bundle-budget.config', () => {
  it('finds the pages it is meant to be budgeting', () => {
    // A guard on the guard: an empty list would make every assertion below
    // vacuously true.
    expect(routes.length).toBeGreaterThan(0)
    expect(routes).toContain('/')
  })

  it('budgets every page route', () => {
    const budgeted = Object.keys(bundleBudgets.routes)
    expect([...routes].sort()).toEqual([...budgeted].sort())
  })

  it('gives every route a route-only budget below its total', () => {
    for (const [route, budget] of Object.entries(bundleBudgets.routes)) {
      expect(budget.routeGzipBytes, route).toBeGreaterThan(0)
      expect(budget.routeGzipBytes, route).toBeLessThan(budget.totalGzipBytes)
    }
  })

  it('leaves room for the shared baseline in every route total', () => {
    // A total below the shared budget could never be met — every route loads
    // the baseline — so such a line would be a typo rather than a tighter
    // budget.
    for (const [route, budget] of Object.entries(bundleBudgets.routes)) {
      expect(budget.totalGzipBytes, route).toBeGreaterThanOrEqual(bundleBudgets.sharedGzipBytes)
    }
  })
})
