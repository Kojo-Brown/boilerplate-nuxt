import { access, readFile } from 'node:fs/promises'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

/**
 * Keeps [`docs/component-testing.md`](../../../docs/component-testing.md) and
 * the setup it describes from drifting apart.
 *
 * The document is half workaround notes: it is where someone who hits
 * `Unhandled Error: [object Object]` or `helper.getColorScheme is not a
 * function` is supposed to find out what happened. Those notes are only useful
 * while the thing they describe is still what the config does, and nothing else
 * would notice if it stopped — `pnpm lint` does not read markdown, and both
 * suites pass whether or not the document still describes them.
 *
 * What this covers: every repo-relative link resolves, every `pnpm` script it
 * quotes exists and is what it says it is, and the three mechanisms it explains
 * are still present where it says they are. What it cannot cover is whether the
 * prose is still true — in particular whether the workarounds are still
 * *needed*, which is a question about Nuxt's and Vitest's versions. The guards
 * in `vitest.nuxt.config.ts` answer that half by failing the run.
 */

const repoRoot = path.resolve(import.meta.dirname, '../../..')
const docPath = 'docs/component-testing.md'

const doc = await readFile(path.join(repoRoot, docPath), 'utf8')

async function exists(relativePath: string): Promise<boolean> {
  try {
    await access(path.join(repoRoot, relativePath))
    return true
  } catch {
    return false
  }
}

/** Repo-relative markdown link targets, `../`-prefixed from `docs/`. */
function linkedPaths(): string[] {
  const targets = new Set<string>()
  for (const match of doc.matchAll(/\]\((\.\.\/[^)#]+)\)/g)) {
    const target = match[1]
    if (target !== undefined) targets.add(path.normalize(path.join('docs', target)))
  }
  return [...targets].sort()
}

describe('docs/component-testing.md', () => {
  it('links only to files that exist', async () => {
    const paths = linkedPaths()

    // A sanity floor: a regex that silently matched nothing would make every
    // assertion below vacuous.
    expect(paths.length).toBeGreaterThan(8)

    for (const target of paths) {
      expect(await exists(target), `${docPath} links to missing ${target}`).toBe(true)
    }
  })

  it('quotes the scripts that package.json actually defines', async () => {
    const { scripts } = JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>
    }

    for (const match of doc.matchAll(/^pnpm (test(?::[a-z]+)?)/gm)) {
      const script = match[1]
      if (script !== undefined) expect(scripts).toHaveProperty(script)
    }

    // The document's central claim about how to run things: `pnpm test` is both
    // configs, which is what makes CI gate on the component and SSR suites
    // without a change to the workflow.
    expect(scripts['test']).toBe('pnpm test:unit && pnpm test:nuxt')
    expect(scripts['test:unit']).toBe('vitest run')
    expect(scripts['test:nuxt']).toBe('vitest run --config vitest.nuxt.config.ts')
  })

  it('describes a config that still carries both workarounds', async () => {
    const config = await readFile(path.join(repoRoot, 'vitest.nuxt.config.ts'), 'utf8')

    // The rolldown plugin substitution, and the dependency it is performed with.
    expect(config).toContain("plugin?.name !== 'nuxt:replace'")
    expect(config).toContain("from '@rollup/plugin-replace'")

    // The colour-mode setup file, and the ordering the document says it needs.
    expect(config).toContain('tests/nuxt/setup.ts')
    expect(config).toContain('setupFiles: [setup, ...setupFiles]')
  })

  it('describes a setup file that still builds the helper from the app config', async () => {
    const setup = await readFile(path.join(repoRoot, 'tests/nuxt/setup.ts'), 'utf8')

    // "built from the same `#color-mode-options` the app is built from" is the
    // reason the colour-mode assertions in the component suite mean anything.
    expect(setup).toContain("from '#color-mode-options'")
    expect(setup).toContain('getColorScheme')
  })

  it('declares the dependencies the two suites need', async () => {
    const { devDependencies } = JSON.parse(
      await readFile(path.join(repoRoot, 'package.json'), 'utf8'),
    ) as { devDependencies: Record<string, string> }

    for (const dependency of ['@nuxt/test-utils', '@vue/test-utils', 'happy-dom']) {
      expect(devDependencies).toHaveProperty(dependency)
    }

    // Pinned, not ranged: @vue/test-utils 2.5 moved to js-beautify 2, whose
    // `nopt` declares `engines.node ^22.22.2 || ^24.15.0 || >=26`, excluding most
    // of this project's own `engines.node` range — and `.npmrc` sets
    // `engine-strict=true`, so the install fails outright rather than warning.
    expect(devDependencies['@vue/test-utils']).toBe('2.4.11')
  })
})
