import { readdir } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { describe, it, expect, vi, afterEach } from 'vitest'

/**
 * The runtime half of the composable design rules.
 *
 * `composable-design/no-import-side-effects` can only see the statements a
 * module writes at its own top level. It cannot see a timer started from inside
 * an initializer, a listener registered by a transitive import, or a global that
 * a dependency assigns on load. This test imports every module in the
 * auto-imported layers with those effects instrumented and asserts none of them
 * happen, so importing a composable stays free — which is what lets Nuxt
 * auto-import the whole directory into every request without paying for the
 * modules nobody calls.
 *
 * Reading `process.env` or building a constant is not a side effect and is not
 * detected here. What is detected is anything that outlives the import: a
 * scheduled callback, a network request, a listener, a write to a shared object.
 */
const LAYERS = ['composables', 'utils', 'stores'] as const

const projectRoot = path.resolve(import.meta.dirname, '../../..')

async function modulesIn(layer: string): Promise<string[]> {
  const entries = await readdir(path.join(projectRoot, layer), { withFileTypes: true })
  return entries
    .filter(
      (entry) => entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts'),
    )
    .map((entry) => `${layer}/${entry.name}`)
    .sort()
}

const modules = (await Promise.all(LAYERS.map(modulesIn))).flat()

/**
 * Everything an import is not allowed to do, paired with where to intercept it.
 * Spies keep the original implementation: the assertion is that the import did
 * not reach for these, not that it cannot.
 */
function armDetectors() {
  return {
    setTimeout: vi.spyOn(globalThis, 'setTimeout'),
    setInterval: vi.spyOn(globalThis, 'setInterval'),
    setImmediate: vi.spyOn(globalThis, 'setImmediate'),
    queueMicrotask: vi.spyOn(globalThis, 'queueMicrotask'),
    fetch: vi.spyOn(globalThis, 'fetch'),
    'process.on': vi.spyOn(process, 'on'),
    'console.log': vi.spyOn(console, 'log'),
    'console.warn': vi.spyOn(console, 'warn'),
    'console.error': vi.spyOn(console, 'error'),
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('importing an auto-imported module has no side effects', () => {
  it('found modules to check', () => {
    // A typo in `LAYERS` or a move to subdirectories would otherwise turn this
    // whole suite into zero assertions that still report green.
    expect(modules.length).toBeGreaterThanOrEqual(10)
    expect(modules).toContain('composables/useToast.ts')
    expect(modules).toContain('utils/sharedComposable.ts')
    expect(modules).toContain('stores/counter.ts')
  })

  it.each(modules)('%s', async (relativePath) => {
    // Force a fresh evaluation: a module another test already imported would
    // otherwise be served from the registry and run nothing at all.
    vi.resetModules()

    const before = new Set(Object.keys(globalThis))
    const detectors = armDetectors()

    const imported: unknown = await import(
      /* @vite-ignore */ pathToFileURL(path.join(projectRoot, relativePath)).href
    )

    const triggered = Object.entries(detectors)
      .filter(([, spy]) => spy.mock.calls.length > 0)
      .map(([name]) => name)

    expect(triggered).toEqual([])

    const added = Object.keys(globalThis).filter((key) => !before.has(key))
    expect(added).toEqual([])

    // Guards against the import silently resolving to nothing — a module that
    // failed to load would pass every assertion above.
    expect(imported).toBeTypeOf('object')
    expect(Object.keys(imported as object).length).toBeGreaterThan(0)
  })
})
