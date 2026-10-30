import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { describe, expect, it } from 'vitest'

/**
 * Keeps [`docs/mutation-testing.md`](../../../docs/mutation-testing.md),
 * [`stryker.config.mjs`](../../../stryker.config.mjs) and the `mutation` CI job
 * from drifting apart.
 *
 * The document is the only place that says *why* the scope is eight modules and
 * why the threshold is below the measured score, and it carries a per-survivor
 * table that is the difference between "this mutant cannot be killed" and
 * "nobody tried". None of that is checkable by a type system, and nothing else
 * would notice it going stale: `pnpm lint` does not read markdown, and
 * `pnpm test:mutation` passes whether or not the document still describes the
 * config it ran under.
 *
 * What this covers: the scope table and the threshold the document quotes are
 * the config's real values, the links resolve, the scripts and files it names
 * exist, and CI actually runs the gate. What it cannot cover is whether the
 * reasoning in the survivor table is still correct — that is a claim about
 * program equivalence, and the only way to check one is to read the code. A row
 * that has gone wrong shows up as a score that moved, which is what
 * `thresholds.break` is for.
 */

const repoRoot = path.resolve(import.meta.dirname, '../../..')
const docPath = 'docs/mutation-testing.md'

const doc = await readFile(path.join(repoRoot, docPath), 'utf8')
const configSource = await readFile(path.join(repoRoot, 'stryker.config.mjs'), 'utf8')

/**
 * The config, evaluated rather than parsed.
 *
 * The specifier is built at run time so this stays an `import()` of a value and
 * not a static dependency on a `.mjs` module with no declarations — which is
 * what a bare `import … from '../../../stryker.config.mjs'` would be, and
 * `nuxt typecheck` would reject it.
 */
interface StrykerConfig {
  mutate: string[]
  plugins: string[]
  thresholds: { break: number }
  vitest: { configFile: string }
  ignorePatterns: string[]
}

const configUrl = pathToFileURL(path.join(repoRoot, 'stryker.config.mjs')).href
const config = ((await import(configUrl)) as { default: StrykerConfig }).default

describe('stryker.config.mjs', () => {
  it('mutates files that exist', async () => {
    expect(config.mutate.length).toBeGreaterThan(0)

    for (const target of config.mutate) {
      // Plain paths, not globs: every entry has to be readable as a file for the
      // scope table in the document to be a table of modules.
      expect(target, `${target} is a glob, which the doc's scope table cannot list`).not.toMatch(
        /[*?]/,
      )
      await expect(
        readFile(path.join(repoRoot, target), 'utf8'),
        `stryker.config.mjs mutates missing ${target}`,
      ).resolves.toBeTypeOf('string')
    }
  })

  it('names the vitest config it runs, and that config exists', async () => {
    expect(config.vitest.configFile).toBe('vitest.config.ts')
    await expect(
      readFile(path.join(repoRoot, config.vitest.configFile), 'utf8'),
    ).resolves.toBeTypeOf('string')
  })

  it('declares the runner plugin explicitly, because pnpm defeats the default glob', async () => {
    // Dropping this is a two-minute detour into a "did you forget to install
    // it?" error about a dependency that is installed. See the note in the
    // config and the section in the doc.
    expect(config.plugins).toContain('@stryker-mutator/vitest-runner')

    const { devDependencies } = JSON.parse(
      await readFile(path.join(repoRoot, 'package.json'), 'utf8'),
    ) as { devDependencies: Record<string, string> }
    expect(Object.keys(devDependencies)).toContain('@stryker-mutator/vitest-runner')
  })

  it('forces .nuxt into the sandbox, which the root tsconfig extends from', async () => {
    expect(config.ignorePatterns).toContain('!/.nuxt')

    // The reason it is needed. If the root tsconfig stops extending something
    // inside a gitignored directory, this workaround can go — and the doc
    // section explaining it with it.
    const tsconfig = await readFile(path.join(repoRoot, 'tsconfig.json'), 'utf8')
    expect(tsconfig).toContain('./.nuxt/tsconfig.json')
  })

  it('sets a breaking threshold, so the run is a gate and not a report', () => {
    expect(config.thresholds.break).toBeGreaterThan(0)
  })
})

describe(docPath, () => {
  it('links only to files that exist', async () => {
    const targets = new Set<string>()
    for (const match of doc.matchAll(/\]\((\.{1,2}\/[^)#]+)\)/g)) {
      const target = match[1]
      if (target !== undefined) targets.add(path.normalize(path.join('docs', target)))
    }

    // A floor: a regex that silently matched nothing would make this vacuous.
    expect(targets.size).toBeGreaterThan(0)

    for (const target of targets) {
      await expect(
        readFile(path.join(repoRoot, target), 'utf8'),
        `${docPath} links to missing ${target}`,
      ).resolves.toBeTypeOf('string')
    }
  })

  it('quotes the pnpm scripts package.json actually defines', async () => {
    const { scripts } = JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>
    }

    const quoted = [...doc.matchAll(/`?pnpm (install|test(?::[a-z]+)?)\b/g)].map(
      (match) => match[1],
    )
    expect(quoted).toContain('test:mutation')

    for (const script of quoted) {
      if (script !== 'install') expect(scripts).toHaveProperty(script as string)
    }
    expect(scripts['test:mutation']).toBe('stryker run')
  })

  it('lists exactly the modules the config mutates, in its scope table', () => {
    // The table is sorted by score, so order is not compared — membership is.
    // A module added to the scope and not to the table is a module whose score
    // nobody wrote down.
    const tabled = [...doc.matchAll(/^\| `((?:server\/)?[a-z]+\/[A-Za-z-]+\.ts)` *\|/gm)].map(
      (match) => match[1],
    )

    expect(tabled.toSorted()).toEqual(config.mutate.toSorted())
  })

  it('quotes the threshold the config enforces', () => {
    // Two places in the prose. Both have to be the real number, or the document
    // argues for headroom that does not exist.
    const quoted = [...doc.matchAll(/`?thresholds\.break`?[^.]*?\bis (\d+)\b/g)].map((match) =>
      Number(match[1]),
    )
    const scoped = [...doc.matchAll(/\bbreak`? (?:is|sits at) (\d+)\b/g)].map((match) =>
      Number(match[1]),
    )
    const mentions = [...quoted, ...scoped]

    expect(mentions.length).toBeGreaterThan(0)
    for (const mention of mentions) expect(mention).toBe(config.thresholds.break)
  })

  it('agrees with the config about which survivors are genuine', () => {
    // The survivor table's row count is quoted in the heading above it. Those
    // two drifting apart is the cheap failure that makes a reader stop trusting
    // the rest of the table.
    const heading = /## The (\d+) survivors that are left/.exec(doc)
    expect(heading?.[1]).toBeDefined()

    const rows = [...doc.matchAll(/^\| `[A-Za-z-]+\.ts:\d+` *\| *(\d+) *\|/gm)].map((match) =>
      Number(match[1]),
    )
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.reduce((total, count) => total + count, 0)).toBe(Number(heading?.[1]))
  })

  it('does not claim a workaround the config has dropped', () => {
    // Both notes describe something the config still does. Either one outliving
    // its line in the config is a reader sent looking for code that is not there.
    expect(configSource).toContain('@stryker-mutator/vitest-runner')
    expect(configSource).toContain("'!/.nuxt'")
    expect(doc).toContain('no TestRunner plugins were loaded')
    expect(doc).toContain('EXTENDS_RESOLVE')
  })
})

describe('the mutation CI job', () => {
  it('runs the gate and uploads the report', async () => {
    const workflow = await readFile(path.join(repoRoot, '.github/workflows/ci.yml'), 'utf8')

    expect(workflow).toContain('pnpm test:mutation')
    expect(workflow).toContain('name: mutation-report')
    // Without the install the sandbox has neither `node_modules` nor `.nuxt`.
    expect(workflow).toContain('pnpm install --frozen-lockfile --strict-peer-dependencies')
  })

  it('keeps Stryker output out of git', async () => {
    const gitignore = await readFile(path.join(repoRoot, '.gitignore'), 'utf8')
    const lines = gitignore.split('\n').map((line) => line.trim())

    expect(lines).toContain('.stryker-tmp')
    expect(lines).toContain('reports')
  })
})
