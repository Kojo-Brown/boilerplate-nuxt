import { access, readFile } from 'node:fs/promises'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

/**
 * Keeps [`docs/tdd-kata.md`](../../../docs/tdd-kata.md) matching the code it
 * walks through.
 *
 * A worked example is the one kind of documentation that is actively harmful
 * when it drifts: prose about a feature can be read as out of date, but a kata
 * that quotes a test which no longer exists teaches the drift as if it were the
 * lesson. Nothing in the normal gates looks at it — `pnpm lint` does not read
 * markdown, and the kata's own subject passes its tests whether or not the
 * document still describes it — so the checks are here.
 *
 * What this covers: the three step headings, every repo-relative path the
 * document names, every test title it quotes, and the two final-state code
 * blocks, which have to still be the code that is in the repository. The last
 * one is the reason the snippets in the document are not illustrative: step 3's
 * `planIdleStep` and `wake` are compared against `utils/idleTimer.ts` and
 * `composables/useIdleTimeout.ts` with comments and whitespace normalised away,
 * so editing either without editing the other fails here.
 *
 * What it cannot cover is whether the prose is still true. Step 1 and step 2's
 * snippets are quoted from commits, not from the working tree, and no test can
 * tell whether the design argument around them still holds. Reading it is for
 * that.
 */

const repoRoot = path.resolve(import.meta.dirname, '../../..')
const docPath = 'docs/tdd-kata.md'

const doc = await readFile(path.join(repoRoot, docPath), 'utf8')

/** Fenced code blocks, by language tag. */
function codeBlocks(language: string): string[] {
  const blocks: string[] = []
  const pattern = new RegExp(`\`\`\`${language}\\n([\\s\\S]*?)\`\`\``, 'g')
  for (const match of doc.matchAll(pattern)) {
    if (match[1] !== undefined) blocks.push(match[1])
  }
  return blocks
}

/**
 * Source with comments and line structure removed, so a snippet quoted without
 * its comments still matches the file it came from.
 */
function normalise(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(?<![:/])\/\/[^\n]*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

async function exists(relative: string): Promise<boolean> {
  try {
    await access(path.join(repoRoot, relative))
    return true
  } catch {
    return false
  }
}

describe('docs/tdd-kata.md', () => {
  it('still records exactly three steps, in order', () => {
    const headings = [...doc.matchAll(/^## Step (\d) — (\w+)$/gm)].map(
      (match) => `${match[1]} ${match[2]}`,
    )

    expect(headings).toEqual(['1 red', '2 green', '3 refactor'])
  })

  it('names the commit subject for each step', () => {
    for (const subject of ['kata step 1 — red', 'kata step 2 — green', 'kata step 3']) {
      expect(doc).toContain(subject)
    }
  })

  it('names only files that exist', async () => {
    // Inline code that looks like a repo-relative source path, plus the target
    // of every relative markdown link. Anything without a `.ts`/`.md`
    // extension — `useAuth`, `pnpm test`, `Math.min(…)` — is not a path.
    const inline = [...doc.matchAll(/`([\w./-]+\.(?:ts|md|vue|mjs))`/g)].map((match) => match[1])
    const links = [...doc.matchAll(/]\((\.[^)\s]+)\)/g)].map((match) =>
      path.posix.join('docs', match[1] ?? ''),
    )

    const named = [...new Set([...inline, ...links])].filter(
      (candidate): candidate is string => candidate !== undefined,
    )

    // Guards the guard: a regex that stopped matching would pass vacuously.
    expect(named.length).toBeGreaterThanOrEqual(6)
    expect(named).toContain('composables/useIdleTimeout.ts')
    expect(named).toContain('utils/idleTimer.ts')

    const missing: string[] = []
    for (const candidate of named) {
      if (!(await exists(candidate))) missing.push(candidate)
    }

    expect(missing).toEqual([])
  })

  it('quotes only test titles that are still in the kata specs', async () => {
    const specs = await Promise.all(
      ['tests/unit/composables/useIdleTimeout.test.ts', 'tests/unit/utils/idleTimer.test.ts'].map(
        (spec) => readFile(path.join(repoRoot, spec), 'utf8'),
      ),
    )

    const quoted = codeBlocks('ts')
      .flatMap((block) => [...block.matchAll(/\bit\('([^']+)'/g)])
      .map((match) => match[1])
      .filter((title): title is string => title !== undefined)

    expect(quoted.length).toBeGreaterThanOrEqual(3)

    const orphaned = quoted.filter((title) => !specs.some((spec) => spec.includes(title)))
    expect(orphaned).toEqual([])
  })

  it('quotes planIdleStep as it is actually written', async () => {
    const source = normalise(await readFile(path.join(repoRoot, 'utils/idleTimer.ts'), 'utf8'))
    const quoted = codeBlocks('ts').filter((block) =>
      block.includes('export function planIdleStep'),
    )

    expect(quoted).toHaveLength(1)
    expect(source).toContain(normalise(quoted[0] ?? ''))
  })

  it('quotes the refactored wake() as it is actually written', async () => {
    const source = normalise(
      await readFile(path.join(repoRoot, 'composables/useIdleTimeout.ts'), 'utf8'),
    )
    const quoted = codeBlocks('ts').filter((block) => block.includes('planIdleStep(now()'))

    expect(quoted).toHaveLength(1)
    expect(source).toContain(normalise(quoted[0] ?? ''))
  })

  it('still shows step 2 as superseded code, not as the current implementation', async () => {
    const source = await readFile(path.join(repoRoot, 'composables/useIdleTimeout.ts'), 'utf8')
    const stepTwo = codeBlocks('ts').filter((block) =>
      block.includes('cancelWake = schedule(wake, tick)'),
    )

    // The whole point of step 3 is that this line is gone. If it comes back,
    // the warning phase can overshoot the timeout again and the document is
    // narrating a fix that is no longer there.
    expect(stepTwo).toHaveLength(1)
    expect(source).not.toContain('schedule(wake, tick)')
  })
})
