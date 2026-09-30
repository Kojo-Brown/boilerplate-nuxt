/**
 * The shape of the OWASP Top 10 checklist, and every rule it has to satisfy.
 *
 * Everything here is pure — it takes a checklist object and, where a rule needs
 * to look at a file, the text of that file. The filesystem walk and the
 * assertions live in `tests/unit/lint/owasp-checklist.test.ts`, which is what
 * CI runs; the checklist itself is data in `owasp.config.ts`. The split is the
 * same one `scripts/bundleBudget.ts` makes for the bundle budget, for the same
 * reason: a rule that is a function of its input can be tested against inputs
 * that are not this repository.
 *
 * ## Why a checklist is code and not a page of prose
 *
 * A security checklist written as a document is accurate on the day it is
 * written and decays silently afterwards. The line "CSRF: double-submit token,
 * covered by `tests/unit/server/csrf.test.ts`" stays on the page after the test
 * is renamed, after it is deleted, and after the middleware it covered is
 * replaced — and it reads exactly the same in all four states. That is worse
 * than having no checklist, because it is evidence that nobody has to check.
 *
 * So each claim here names the test that proves it, by file and by the test's
 * own title, and the gate resolves both against the repository on every run. A
 * renamed test breaks the build in the checklist rather than quietly turning one
 * of its lines into fiction.
 *
 * ## What the gate does not prove
 *
 * It proves that a named test exists and runs, not that the test is any good.
 * Nothing mechanical can close that gap: the value of the citation is that a
 * reviewer can open it, and the value of the gate is that the citation still
 * points somewhere. Read it as a map with working links, not as an audit.
 *
 * It also cannot tell that a category is missing a mitigation it ought to have
 * — only the author knows that. What it can insist on is that the absence is
 * written down: a category with no mitigations must carry a `gap` saying so,
 * which is the difference between a risk that was considered and one that was
 * forgotten. See `docs/owasp-top-10.md`.
 */

/**
 * The ten categories of the OWASP Top 10:2021, in rank order, with the titles
 * OWASP gives them.
 *
 * 2021 rather than an older edition because it is the current one, and the
 * merges it introduced matter to how this application is organised: CSRF and
 * path traversal are filed under Broken Access Control here rather than in
 * categories of their own, and XSS is part of Injection.
 */
export const OWASP_2021 = [
  { id: 'A01', title: 'Broken Access Control' },
  { id: 'A02', title: 'Cryptographic Failures' },
  { id: 'A03', title: 'Injection' },
  { id: 'A04', title: 'Insecure Design' },
  { id: 'A05', title: 'Security Misconfiguration' },
  { id: 'A06', title: 'Vulnerable and Outdated Components' },
  { id: 'A07', title: 'Identification and Authentication Failures' },
  { id: 'A08', title: 'Software and Data Integrity Failures' },
  { id: 'A09', title: 'Security Logging and Monitoring Failures' },
  { id: 'A10', title: 'Server-Side Request Forgery (SSRF)' },
] as const

export type OwaspCategoryId = (typeof OWASP_2021)[number]['id']

/**
 * One test file, and the titles inside it that prove a mitigation.
 *
 * Titles are the exact string passed to `it(…)`, because that is the string a
 * reader searches for and the string the reporter prints. Citing the file alone
 * would survive the deletion of the only test that mattered.
 */
export interface OwaspEvidence {
  /** Repo-relative path, e.g. `tests/unit/server/csrf.test.ts`. */
  file: string
  /** Exact `it(…)` titles in that file. At least one. */
  tests: readonly string[]
}

export interface OwaspMitigation {
  /** Stable kebab-case handle, unique across the whole checklist. */
  id: string
  /** One sentence: what an attacker tries, and what stops them. */
  summary: string
  /** Repo-relative source paths that implement it. At least one. */
  implementation: readonly string[]
  /** The tests that prove it. At least one. */
  evidence: readonly OwaspEvidence[]
}

export interface OwaspCategory {
  id: OwaspCategoryId
  /** Must equal the OWASP title for `id`; the gate compares them. */
  title: string
  mitigations: readonly OwaspMitigation[]
  /**
   * Why this category has no mitigation yet. Required when `mitigations` is
   * empty, and rejected when it is not — a category cannot be both covered and
   * excused.
   */
  gap?: string
}

export type OwaspChecklist = readonly OwaspCategory[]

/** Every `(category, mitigation)` pair, flattened, in checklist order. */
export function allMitigations(
  checklist: OwaspChecklist,
): { category: OwaspCategory; mitigation: OwaspMitigation }[] {
  return checklist.flatMap((category) =>
    category.mitigations.map((mitigation) => ({ category, mitigation })),
  )
}

/** Every distinct source path the checklist claims as an implementation. */
export function citedImplementationFiles(checklist: OwaspChecklist): string[] {
  const files = allMitigations(checklist).flatMap(({ mitigation }) => mitigation.implementation)
  return [...new Set(files)].sort()
}

/** Every distinct test file the checklist cites as evidence. */
export function citedTestFiles(checklist: OwaspChecklist): string[] {
  const files = allMitigations(checklist).flatMap(({ mitigation }) =>
    mitigation.evidence.map((evidence) => evidence.file),
  )
  return [...new Set(files)].sort()
}

/**
 * Titles of the `it(…)` / `test(…)` calls in a test file's source.
 *
 * Anchored to the start of a line, so a call is only counted where a statement
 * can actually be: `it('…')` written inside a doc comment arrives as ` * it('…')`
 * and is skipped. That is the whole of the comment handling — blanking comment
 * bodies first, which is what this repo's other source scans do, would truncate
 * any line containing `://` and could swallow a real title. Over-counting a
 * commented-out example would only make the "this title exists" check more
 * permissive; under-counting a live one would fail the build for a test that is
 * there.
 *
 * `describe` blocks are deliberately not collected. A citation names the
 * assertion, and a `describe` is a grouping — the titles this returns are
 * exactly the strings the verbose reporter prints as passing.
 */
export function extractTestTitles(source: string): string[] {
  const titles: string[] = []
  const pattern =
    /^[ \t]*(?:it|test)(?:\.\w+)*(?:\([^)]*\))?\s*\(\s*(['"`])((?:\\.|(?!\1)[\s\S])*?)\1/gm

  for (const match of source.matchAll(pattern)) {
    titles.push(match[2] ?? '')
  }

  return titles
}

/** A path is repo-relative if it is neither absolute nor a `..` escape. */
function isRepoRelative(value: string): boolean {
  return value.length > 0 && !value.startsWith('/') && !value.startsWith('.')
}

/**
 * Everything wrong with a checklist that can be decided without reading the
 * repository: coverage, ordering, titles, duplicate handles, empty claims, and
 * the gap rule.
 *
 * Returns a list rather than throwing on the first problem, so a checklist with
 * three mistakes reports three.
 */
export function checklistProblems(checklist: OwaspChecklist): string[] {
  const problems: string[] = []

  if (checklist.length !== OWASP_2021.length) {
    problems.push(
      `the checklist has ${checklist.length} categories; the OWASP Top 10:2021 has ${OWASP_2021.length}`,
    )
  }

  OWASP_2021.forEach((expected, index) => {
    const actual = checklist[index]

    if (!actual) {
      problems.push(`${expected.id} (${expected.title}) is missing`)
      return
    }

    // Order is part of the contract: the list is a ranking, and a checklist
    // that reorders it stops being readable next to the published one.
    if (actual.id !== expected.id) {
      problems.push(`position ${index + 1} is ${actual.id}; the Top 10 has ${expected.id} there`)
    } else if (actual.title !== expected.title) {
      problems.push(
        `${actual.id} is titled ${JSON.stringify(actual.title)}; OWASP calls it ${JSON.stringify(expected.title)}`,
      )
    }
  })

  const seenIds = new Set<string>()

  for (const category of checklist) {
    if (category.mitigations.length === 0) {
      if (!category.gap?.trim()) {
        problems.push(
          `${category.id} has no mitigations and no gap explaining why — an uncovered category has to say so`,
        )
      }
    } else if (category.gap !== undefined) {
      problems.push(
        `${category.id} carries a gap note as well as ${category.mitigations.length} mitigation(s); a gap means nothing is covered`,
      )
    }

    for (const mitigation of category.mitigations) {
      const where = `${category.id}/${mitigation.id}`

      if (seenIds.has(mitigation.id)) problems.push(`${where}: duplicate mitigation id`)
      seenIds.add(mitigation.id)

      if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(mitigation.id)) {
        problems.push(`${where}: id is not kebab-case`)
      }

      if (!mitigation.summary.trim()) problems.push(`${where}: empty summary`)

      if (mitigation.implementation.length === 0) {
        problems.push(`${where}: names no implementation file`)
      }

      for (const file of mitigation.implementation) {
        if (!isRepoRelative(file))
          problems.push(`${where}: implementation path ${file} is not repo-relative`)
      }

      if (mitigation.evidence.length === 0) {
        problems.push(`${where}: names no test — every mitigation on this list has to be provable`)
      }

      for (const evidence of mitigation.evidence) {
        if (!isRepoRelative(evidence.file)) {
          problems.push(`${where}: evidence path ${evidence.file} is not repo-relative`)
        }

        // Vitest only collects `tests/unit/**/*.test.ts` (see vitest.config.ts).
        // Evidence anywhere else would be a citation to something CI never runs.
        if (!evidence.file.startsWith('tests/unit/') || !evidence.file.endsWith('.test.ts')) {
          problems.push(
            `${where}: ${evidence.file} is outside the unit suite, so nothing would run it`,
          )
        }

        if (evidence.tests.length === 0) {
          problems.push(`${where}: cites ${evidence.file} without naming a test in it`)
        }

        if (new Set(evidence.tests).size !== evidence.tests.length) {
          problems.push(`${where}: cites the same test twice in ${evidence.file}`)
        }
      }
    }
  }

  return problems
}

/**
 * Citations that no longer resolve, given the titles each cited file actually
 * contains. `titlesByFile` is keyed by the same repo-relative path the checklist
 * uses; a file missing from the map is reported as missing.
 */
export function danglingEvidence(
  checklist: OwaspChecklist,
  titlesByFile: ReadonlyMap<string, readonly string[]>,
): string[] {
  const dangling: string[] = []

  for (const { category, mitigation } of allMitigations(checklist)) {
    for (const evidence of mitigation.evidence) {
      const titles = titlesByFile.get(evidence.file)

      if (!titles) {
        dangling.push(`${category.id}/${mitigation.id}: ${evidence.file} does not exist`)
        continue
      }

      for (const title of evidence.tests) {
        if (!titles.includes(title)) {
          dangling.push(
            `${category.id}/${mitigation.id}: ${evidence.file} has no test titled ${JSON.stringify(title)}`,
          )
        }
      }
    }
  }

  return dangling
}

/** How many mitigations each category carries, for a coverage summary. */
export function coverageSummary(checklist: OwaspChecklist): {
  covered: OwaspCategoryId[]
  uncovered: OwaspCategoryId[]
  mitigations: number
  citedTests: number
} {
  const covered: OwaspCategoryId[] = []
  const uncovered: OwaspCategoryId[] = []

  for (const category of checklist) {
    ;(category.mitigations.length > 0 ? covered : uncovered).push(category.id)
  }

  const citedTests = allMitigations(checklist).reduce(
    (total, { mitigation }) =>
      total + mitigation.evidence.reduce((sum, evidence) => sum + evidence.tests.length, 0),
    0,
  )

  return {
    covered,
    uncovered,
    mitigations: allMitigations(checklist).length,
    citedTests,
  }
}
