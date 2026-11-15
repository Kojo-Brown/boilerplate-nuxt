import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

/**
 * Keeps [`docs/integration-testing.md`](../../../docs/integration-testing.md),
 * `vitest.integration.config.ts`, the suites themselves and the `integration`
 * CI job from drifting apart.
 *
 * The same argument as `mutation-testing.test.ts`. The document is the only
 * place that records *why* these suites exist — which claims `pg-proxy` cannot
 * reach, which three mistakes deadlock a new suite, what the gate still does
 * not cover — and nothing else would notice it going stale: `pnpm lint` does
 * not read markdown, and `pnpm test:integration` passes whether or not the
 * document still describes the suites that ran.
 *
 * It runs in the **unit** suite, deliberately. A drift check that needed Docker
 * would be checked only by the gate it is checking.
 */
const repoRoot = path.resolve(import.meta.dirname, '../../..')

const doc = await readFile(path.join(repoRoot, 'docs/integration-testing.md'), 'utf8')
const workflow = await readFile(path.join(repoRoot, '.github/workflows/ci.yml'), 'utf8')
const config = await readFile(path.join(repoRoot, 'vitest.integration.config.ts'), 'utf8')
const manifest = JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8')) as {
  scripts: Record<string, string>
  devDependencies: Record<string, string>
}

async function suiteFiles(): Promise<string[]> {
  const entries = await readdir(path.join(repoRoot, 'tests/integration'))
  return entries.filter((entry) => entry.endsWith('.test.ts')).sort()
}

describe('the integration gate is wired up', () => {
  it('is a script of its own', () => {
    expect(manifest.scripts['test:integration']).toBe(
      'vitest run --config vitest.integration.config.ts',
    )
  })

  it('is not part of `pnpm test`', () => {
    // `pnpm test` is what a contributor runs without thinking about it, and on
    // a machine with no Docker socket these suites cannot run at all. Folding
    // them in would make the cheap gate fail for a reason that has nothing to
    // do with the change in front of them.
    expect(manifest.scripts['test']).not.toContain('integration')
  })

  it('declares the Testcontainers module it imports', () => {
    expect(manifest.devDependencies['@testcontainers/postgresql']).toBeDefined()
  })

  it('runs as its own CI job', () => {
    expect(workflow).toContain('name: Postgres integration (Testcontainers)')
    expect(workflow).toContain('run: pnpm test:integration')
  })

  it('runs the suites one at a time against one database', () => {
    // Both of these are load-bearing rather than stylistic: the suites share a
    // server and each truncates in `beforeEach`, so two running at once would
    // make every fixture a race against another suite's cleanup.
    expect(config).toContain('singleFork: true')
    expect(config).toContain('fileParallelism: false')
  })
})

describe('docs/integration-testing.md', () => {
  it('describes every suite that exists, and no suite that does not', async () => {
    const files = await suiteFiles()

    expect(files.length).toBeGreaterThan(0)

    for (const file of files) {
      expect(doc).toContain(`tests/integration/${file}`)
    }

    // The other direction: a suite named in the document that has been deleted
    // or renamed is just as stale as one that was never written about.
    const named = [...doc.matchAll(/tests\/integration\/([\w.-]+\.test\.ts)/g)].map(
      (match) => match[1],
    )
    expect([...new Set(named)].sort()).toEqual(files)
  })

  it('names the image the suites actually start', async () => {
    const setup = await readFile(path.join(repoRoot, 'tests/integration/setup/global.ts'), 'utf8')
    const pinned = /POSTGRES_IMAGE = '([^']+)'/.exec(setup)?.[1]

    expect(pinned).toBeDefined()
    expect(doc).toContain(pinned as string)
  })

  it('is linked from the instructions that tell an agent to run the gate', async () => {
    const claudeMd = await readFile(path.join(repoRoot, 'CLAUDE.md'), 'utf8')

    expect(claudeMd).toContain('pnpm test:integration')
    expect(claudeMd).toContain('docs/integration-testing.md')
  })
})
