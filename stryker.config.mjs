/**
 * Mutation testing: does the suite in `vitest.config.ts` actually *assert*?
 *
 * Coverage says a line ran. It cannot say the line mattered. Stryker answers the
 * other question — it changes the source one edit at a time (`<` becomes `<=`,
 * a branch becomes `false`, a string becomes `""`) and re-runs the tests that
 * cover that line. A mutant the suite still passes is a line whose behaviour no
 * assertion pins down. `pnpm test:mutation` is the gate; `thresholds.break`
 * below is what makes it one.
 *
 * See docs/mutation-testing.md — in particular before changing `mutate` or
 * `thresholds.break`, both of which are easy to "fix" by making the gate
 * measure less.
 *
 * @type {import('@stryker-mutator/api/core').PartialStrykerOptions}
 */
export default {
  packageManager: 'pnpm',

  testRunner: 'vitest',

  // Explicit, rather than relying on the default `['@stryker-mutator/*']` glob.
  // That glob is resolved against `node_modules/@stryker-mutator/*`, which under
  // pnpm holds only this project's direct dependencies as symlinks — the runner
  // is there, but the glob walks the real paths under `.pnpm` and comes back
  // empty. The failure is `Cannot find TestRunner plugin "vitest". In fact, no
  // TestRunner plugins were loaded`, which reads like a missing dependency and
  // is not one.
  plugins: ['@stryker-mutator/vitest-runner'],

  // The node suite only. `vitest.nuxt.config.ts`'s two projects are deliberately
  // not here: the `component` project boots a Nuxt app (~20s) before it collects
  // a test and the `ssr` project starts a real Nuxt dev server, so either one
  // would be paid again per mutant, and neither tests the modules below —
  // components are covered there, and this gate is about decision logic.
  vitest: { configFile: 'vitest.config.ts' },

  // Stryker records which tests touch which line during the initial run and then
  // runs only those per mutant. Across the scope below that is ~6 of 2191 tests
  // per mutant instead of all of them; without it this config would not finish
  // inside a CI job.
  coverageAnalysis: 'perTest',

  /**
   * The scope: modules that decide something, where a weak assertion is a bug
   * waiting to happen rather than a cosmetic gap.
   *
   * Deliberately not `utils/**` + `server/utils/**`. That is ~13,700 lines and
   * would take the better part of an hour; a gate nobody waits for is a gate
   * nobody runs. These eight are the ones where the mutants Stryker generates
   * map onto real failures — a boundary off by one, a security carve-out that
   * stops carving, a comparator that disagrees with itself. Streaming, storage
   * and session modules are I/O orchestration whose mutants are mostly about
   * which await runs first; they are tested, just not usefully mutated.
   *
   * Adding a module here is welcome. Removing one to recover a threshold is the
   * thing docs/mutation-testing.md asks you not to do.
   */
  mutate: [
    'utils/dataTable.ts',
    'utils/idleTimer.ts',
    'utils/payloadBudget.ts',
    'server/utils/access-policy.ts',
    'server/utils/rate-limit-policy.ts',
    'server/utils/request-path.ts',
    'server/utils/route-pattern.ts',
    'server/utils/vitals-aggregate.ts',
  ],

  // `.nuxt` is gitignored, so Stryker leaves it out of the sandbox it copies the
  // project into — and the root `tsconfig.json` extends `./.nuxt/tsconfig.json`.
  // Vite resolves that extends chain before it transforms a single file, so
  // without this every mutant run dies in the dry run with `TSConfckParseError:
  // EXTENDS_RESOLVE ... failed to resolve "extends":"./.nuxt/tsconfig.json"`.
  // It is 550 kB of generated types; `pnpm install`'s `nuxt prepare` is what puts
  // it there, so a cold CI checkout has it by the time this runs.
  ignorePatterns: ['!/.nuxt'],

  reporters: ['html', 'clear-text', 'progress'],

  // Survivors are the output worth reading; the tests that killed a mutant are
  // not, and at ~600 mutants listing them buries the report in a CI log.
  clearTextReporter: { reportTests: false },

  htmlReporter: { fileName: 'reports/mutation/index.html' },

  /**
   * `break` is the gate: Stryker exits non-zero below it.
   *
   * 90 against a measured 91.65 — about ten mutants of room. The gap is not
   * slack to spend. It is there because most of what survives in this scope is
   * *equivalent*: a mutant describing a program indistinguishable from the
   * original, which no test can kill, and which ones Stryker generates shifts
   * with refactors that change no behaviour at all. docs/mutation-testing.md
   * lists every survivor as of this writing with the argument for each, so the
   * first question about a red run is which column moved — a drop in `# killed`
   * is a weakened test, a jump in `# survived` on an untouched file is usually
   * a new equivalent mutant. Raise this when the real score rises; do not lower
   * it to make a red build green.
   *
   * `high`/`low` only colour the HTML report.
   */
  thresholds: { high: 95, low: 90, break: 90 },

  tempDirName: '.stryker-tmp',
}
