import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'

import { describe, it, expect } from 'vitest'

import { owaspTopTen } from '../../../owasp.config'
import {
  allMitigations,
  checklistProblems,
  citedImplementationFiles,
  citedTestFiles,
  coverageSummary,
  danglingEvidence,
  extractTestTitles,
  OWASP_2021,
} from '../../../scripts/owaspChecklist'

/**
 * The gate behind `owasp.config.ts`: every claim on the checklist still resolves
 * to something in this repository.
 *
 * A security checklist decays in three ways, and this covers all three:
 *
 *  1. **A category quietly disappears.** The shape rules below pin the list to
 *     the published Top 10:2021 — ten entries, in rank order, under OWASP's own
 *     titles — so a category cannot be dropped because nothing was done about
 *     it. One with no mitigations has to carry a `gap` saying why, which is the
 *     difference between a risk that was weighed and one that was forgotten.
 *
 *  2. **A cited test is renamed or deleted.** Each mitigation names its tests by
 *     file *and* by the exact `it(…)` title, and both are resolved against the
 *     filesystem here. This is the rule that does the work: a checklist whose
 *     citations are checked on every run is the only kind that stays true.
 *
 *  3. **A control is added and never filed.** The inverse rule at the bottom
 *     requires every file in `server/middleware/` to appear on the checklist.
 *     Middleware is where this application's request-level controls live — auth,
 *     CSRF, rate limiting — and a fifth one joining the chain unfiled is exactly
 *     the drift that makes a checklist stop describing the system.
 *
 * What it cannot do is judge whether a cited test is a good test, or whether a
 * category has the mitigations it ought to. Both are review's job. See
 * `docs/owasp-top-10.md`.
 */

const projectRoot = path.resolve(import.meta.dirname, '../../..')

/** The `it(…)` titles in every test file the checklist cites, keyed by path. */
async function titlesByCitedFile(): Promise<Map<string, string[]>> {
  const found = new Map<string, string[]>()

  await Promise.all(
    citedTestFiles(owaspTopTen).map(async (file) => {
      const source = await readFile(path.join(projectRoot, file), 'utf8').catch(() => null)
      if (source !== null) found.set(file, extractTestTitles(source))
    }),
  )

  return found
}

async function exists(relative: string): Promise<boolean> {
  return stat(path.join(projectRoot, relative)).then(
    () => true,
    () => false,
  )
}

const titles = await titlesByCitedFile()

describe('the OWASP Top 10 checklist', () => {
  it('covers the ten categories of the Top 10:2021, in rank order', () => {
    expect(owaspTopTen.map((category) => `${category.id} ${category.title}`)).toEqual(
      OWASP_2021.map((category) => `${category.id} ${category.title}`),
    )
  })

  it('satisfies every structural rule at once', () => {
    // `checklistProblems` collects rather than throwing, so a checklist with
    // three mistakes reports three. Among them: no duplicate mitigation ids, no
    // mitigation without an implementation file or a test, no evidence outside
    // the unit suite, and the gap rule.
    expect(checklistProblems(owaspTopTen)).toEqual([])
  })

  it('names an implementation file that exists for every mitigation', async () => {
    const files = citedImplementationFiles(owaspTopTen)
    const missing = (
      await Promise.all(files.map(async (file) => ((await exists(file)) ? null : file)))
    ).filter((file) => file !== null)

    expect(
      missing,
      'A mitigation pointing at a file that was moved or deleted is not a mitigation.',
    ).toEqual([])
  })

  it('cites a test file that exists for every mitigation', () => {
    const missing = citedTestFiles(owaspTopTen).filter((file) => !titles.has(file))

    expect(missing).toEqual([])
  })

  it('cites tests that are still called what the checklist says they are', () => {
    // The rule the whole file exists for. `danglingEvidence` reports each broken
    // citation as `A0x/mitigation-id: file has no test titled "…"`, which is
    // enough to fix it without opening anything.
    expect(
      danglingEvidence(owaspTopTen, titles),
      'Rename a test and the line claiming it proves something has to be updated too — that is ' +
        'the point of citing titles rather than files. See docs/owasp-top-10.md.',
    ).toEqual([])
  })

  it('reads a title out of a test file the way the files are actually written', () => {
    // The citation check is only worth anything if the extractor sees real
    // titles, so this pins it against a file in this suite rather than against a
    // fixture: an extractor that returned nothing would make every citation
    // above pass vacuously once the "file exists" rule was satisfied.
    const source = `
      describe('a group', () => {
        it('a plain title', () => {})
        it("a double-quoted title", () => {})
        it(\`a templated title\`, () => {})
        it.each([1])('a parameterised title', () => {})
        test('a test() title', () => {})
        it('a title with an apostrophe\\'s escape', () => {})
      })
      // it('a commented-out title', () => {})
       * it('a title in a doc comment', () => {})
    `

    expect(extractTestTitles(source)).toEqual([
      'a plain title',
      'a double-quoted title',
      'a templated title',
      'a parameterised title',
      'a test() title',
      "a title with an apostrophe\\'s escape",
    ])
  })

  it('files every request middleware under some category', async () => {
    // Middleware applies to routes nobody has written yet, which makes it the
    // part of this application a checklist most needs to keep up with.
    const middleware = (await readdir(path.join(projectRoot, 'server/middleware')))
      .filter((name) => name.endsWith('.ts'))
      .map((name) => `server/middleware/${name}`)
      .sort()

    const filed = new Set(citedImplementationFiles(owaspTopTen))
    const unfiled = middleware.filter((file) => !filed.has(file))

    expect(middleware.length).toBeGreaterThan(0)
    expect(
      unfiled,
      'A new middleware runs on every request. Add it to owasp.config.ts under the category it ' +
        'belongs to, or say in its header why it is not a security control.',
    ).toEqual([])
  })

  it('is written up in docs/owasp-top-10.md, mitigation by mitigation', async () => {
    // The doc is the prose; `owasp.config.ts` is the data. Nothing generates one
    // from the other — this only asserts the two know about the same things, so
    // a mitigation cannot be added to the table and left out of the explanation.
    const doc = await readFile(path.join(projectRoot, 'docs/owasp-top-10.md'), 'utf8')

    const undocumented = [
      ...owaspTopTen.map((category) => category.id),
      ...allMitigations(owaspTopTen).map(({ mitigation }) => mitigation.id),
    ].filter((id) => !doc.includes(id))

    expect(undocumented).toEqual([])
  })

  it('reports the coverage it actually has, gaps included', () => {
    const summary = coverageSummary(owaspTopTen)

    // Not a target to be moved when it fails — a record of where this
    // boilerplate stands, so that a category losing its last mitigation is a
    // failing assertion rather than a table that quietly got shorter.
    expect(summary.uncovered).toEqual(['A06'])
    expect(summary.covered).toHaveLength(9)
    expect(summary.mitigations).toBeGreaterThanOrEqual(35)
    expect(summary.citedTests).toBeGreaterThanOrEqual(150)
  })
})
