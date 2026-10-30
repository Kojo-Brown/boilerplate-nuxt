# Mutation testing: does the suite actually assert?

Coverage tells you a line ran. It cannot tell you the line mattered. A test that
imports a module, calls every function and asserts `expect(result).toBeDefined()`
reports 100% coverage and would not notice the module being rewritten.

Mutation testing asks the other question. Stryker changes the source one edit at
a time — `<` becomes `<=`, a condition becomes `false`, a string becomes `""` —
and re-runs the tests that cover the changed line. A mutant the suite still
passes is a line whose behaviour no assertion pins down.

```
pnpm test:mutation
  │
  ├─ stryker.config.mjs              ← scope, threshold, the two workarounds
  │
  ├─ copies the project to .stryker-tmp/sandbox-*/
  │    └─ runs vitest.config.ts once  ← records which tests touch which line
  │
  ├─ for each mutant: re-runs only the tests covering it
  │    killed   → some test failed. Good.
  │    survived → every covering test still passed. A gap, or an equivalent mutant.
  │    no cov   → no test reaches the line at all.
  │
  └─ exit 1 below thresholds.break, + reports/mutation/index.html
```

| File                                                                                      | What it owns                                   |
| ----------------------------------------------------------------------------------------- | ---------------------------------------------- |
| [`stryker.config.mjs`](../stryker.config.mjs)                                             | The scope, the threshold, the runner wiring    |
| [`tests/unit/lint/mutation-testing.test.ts`](../tests/unit/lint/mutation-testing.test.ts) | That this document and that config still agree |
| [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) (`mutation`)                    | The gate, on one Node major                    |

## Running it

```
pnpm test:mutation
```

About two minutes for ~590 mutants, and it needs `node_modules` and `.nuxt` —
`pnpm install` produces both. The HTML report at `reports/mutation/index.html` is
the one worth reading: it shows each mutant in its own source line, which the
terminal output cannot. CI uploads it as an artifact on every run.

To work on one file, narrow the scope from the command line rather than editing
the config:

```
pnpm test:mutation --mutate utils/payloadBudget.ts
```

## What is in scope, and why not everything

Eight modules, listed in `stryker.config.mjs`:

| Module                              | Score     |
| ----------------------------------- | --------- |
| `server/utils/access-policy.ts`     | 100.00    |
| `utils/idleTimer.ts`                | 100.00    |
| `server/utils/vitals-aggregate.ts`  | 94.52     |
| `server/utils/request-path.ts`      | 92.50     |
| `server/utils/rate-limit-policy.ts` | 92.39     |
| `server/utils/route-pattern.ts`     | 91.67     |
| `utils/payloadBudget.ts`            | 90.00     |
| `utils/dataTable.ts`                | 87.43     |
| **total**                           | **91.65** |

Not `utils/**` plus `server/utils/**`. That is about 13,700 lines, which takes
the better part of an hour, and a gate nobody waits for is a gate nobody runs.
These eight are where the mutants Stryker generates land on real failures: a
boundary off by one, a security carve-out that stops carving, a comparator that
disagrees with itself. The streaming, storage and session modules are I/O
orchestration whose mutants are mostly about which `await` happens first; they
are well tested, just not usefully mutated.

Only the node suite (`vitest.config.ts`) runs. [`vitest.nuxt.config.ts`](../vitest.nuxt.config.ts)'s two
projects are deliberately excluded: the `component` project boots a Nuxt app
before it collects a test and the `ssr` project starts a real Nuxt dev server, so
either would be paid again per mutant — and neither covers the modules above.
See [`docs/component-testing.md`](./component-testing.md) for that split.

**Adding a module here is welcome. Removing one to recover the threshold is the
thing this document asks you not to do.** Same for `thresholds.break`: it is 90
against a measured 91.65, and the gap is not slack to spend.

## Two things had to be worked around

Both are in `stryker.config.mjs` with the same notes; they are here because the
first error message is actively misleading and the second mentions no Stryker
file at all.

**`plugins` is listed explicitly.** Stryker's default is to discover plugins by
globbing `@stryker-mutator/*`. Under pnpm that directory holds symlinks to the
store, the glob comes back empty, and the run dies with `Cannot find TestRunner
plugin "vitest". In fact, no TestRunner plugins were loaded. Did you forget to
install it?` — which reads like a missing dependency and is not one. The runner
is installed; naming it is what makes it findable.

**`.nuxt` is forced into the sandbox** with `ignorePatterns: ['!/.nuxt']`.
Stryker mutates a copy of the project and builds that copy from the files git
tracks, so a gitignored directory is left out. The root `tsconfig.json` extends
`./.nuxt/tsconfig.json`, and Vite resolves the extends chain before it transforms
anything, so without this every run fails in the dry run with:

```
TSConfckParseError: EXTENDS_RESOLVE (undefined) failed to resolve
"extends":"./.nuxt/tsconfig.json" in .stryker-tmp/sandbox-xxxxxx/tsconfig.json
```

It is 550 kB of generated types, and `pnpm install`'s `postinstall` (`nuxt
prepare`) writes it, so a cold CI checkout has it before this job runs.

## What the first run found

Worth recording, because the point of the exercise was the findings and not the
tooling. The first green run scored **84.16%** with 87 survivors. Six of those
were in `publicApiPatterns`, including one that drops every entry — and the only
test reading it was a `for` loop over its result, so an empty list made the gate
pass by checking nothing. That gate is what stops a `public` carve-out in the
default-deny table from outliving the route it was opened for.

The rest of what was genuinely weak, now fixed:

- **`normalisePathname` never reached its decode cap.** Every input settled
  inside `MAX_DECODE_PASSES`, so the loop always exited early and both the
  counter and its comparison could be mutated — including into an unbounded loop
  — without a failure. The cap is the bound on how much decoding a nested-escape
  input can ask for.
- **Three anchored patterns in `rate-limit-policy.ts` could lose an anchor.**
  Every spoofing case in the suite had its junk at the end, which leaves an
  unanchored start matching. Losing `^` turns a whole-string allowlist into
  "contains something address-shaped", and `usableAddress` returns the whole
  string — junk included — into a storage key and a log line.
- **The hop count was never read past the first position**, so dropping the
  empty-entry filter from the `x-forwarded-for` chain changed nothing.
- **`checkPayloadBudget` never saw a payload exactly at its budget**, and
  `formatBytes` never saw exactly 10 kB — both sides of a `<`.
- **Four branches of the table comparator were unobservable with the test data.**
  Positive bigints agree with the collator's numeric collation, so
  `compare(9n, 10n)` passes with the bigint branch deleted; negative ones
  disagree. Two dates whose weekday names happen to sort chronologically do the
  same for the `Date` branch.
- **`defaultFormat` was tested with `null` but not `undefined`**, which is the
  one an absent optional field actually arrives as.

That took the score to 91.65%.

## The 47 survivors that are left

Most of them cannot be killed. An **equivalent mutant** describes a program
indistinguishable from the original — a defensive branch whose absence changes
no output, an arm of a ternary nothing can reach. They are the normal reason a
real-world score is not 100, and they are why `break` sits below the measured
number: which ones Stryker generates shifts with refactors that change no
behaviour.

Each one below was checked rather than assumed.

| Where                      | #   | Why it survives                                                                                                                                                                                                                                                                       |
| -------------------------- | --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dataTable.ts:58`          | 10  | The `string`/`string` fast path. The fallback is `collator.compare(String(a), String(b))`, and `String(s) === s` for a string — equivalent by construction.                                                                                                                           |
| `dataTable.ts:44`          | 9   | The `boolean`/`boolean` fast path. `'false' < 'true'` for the collator, and `false < true` for the branch, agree on all four possible pairs.                                                                                                                                          |
| `payloadBudget.ts:102`     | 5   | The `0` arm of the field-name tie-break. Object keys are unique, so two entries never compare equal and only the `-1` arm decides the order. Checked against twelve tied fields, which crosses V8's insertion-sort threshold; every mutant still sorted identically.                  |
| `rate-limit-policy.ts:193` | 4   | **Genuine.** The `^…$` anchors and the `{1,3}` quantifiers on the IPv4-with-port pattern. Killing them means asserting that an address-shaped string with a hex-looking prefix keeps its port — a true claim about an allowlist of characters, and the next thing to strengthen here. |
| `dataTable.ts:167`         | 3   | The explicit `a.index - b.index` tie-break. `Array.prototype.sort` has been stable since ES2019, so equal elements keep their order whatever this returns.                                                                                                                            |
| `route-pattern.ts:79`      | 2   | `if (pattern.prefix === '') return true`, the `/**` catch-all. The line below it already answers `true` for any pathname starting with `/`, which is every normalised pathname.                                                                                                       |
| `rate-limit-policy.ts:236` | 2   | `if (input.trustProxyHops <= 0) return socket`. With zero or fewer hops the index below is `chain[chain.length]` or past it — `undefined` either way — so the fall-through returns the socket regardless.                                                                             |
| `payloadBudget.ts:114`     | 1   | The `bytes === null` short-circuit in the budget check. `null <= budgetBytes` coerces to `0 <= budgetBytes`, which is already `true`.                                                                                                                                                 |
| `payloadBudget.ts:137`     | 1   | The `report.bytes === null` half of the warning guard. A report whose `bytes` is `null` is always `withinBudget`, so that operand is unreachable.                                                                                                                                     |
| `payloadBudget.ts:39`      | 1   | Emptying the `catch` body. `JSON.stringify` threw, so the function returns `undefined`, and the next line maps that to `null` anyway.                                                                                                                                                 |
| `payloadBudget.ts:143`     | 1   | Cosmetic: the empty `detail` when there are no fields to name. The test asserts the message does _not_ contain `Largest fields`, which a different non-empty string also satisfies.                                                                                                   |
| `rate-limit-policy.ts:238` | 1   | The per-entry `.trim()`. `normaliseAddress` trims again downstream.                                                                                                                                                                                                                   |
| `route-pattern.ts:92`      | 1   | `prefix.length * 2` → `/ 2`. The doubling keeps the low bit free for the exact/wildcard bit; both scalings are monotonic in length, and an exact key matching a wildcard's path is never shorter than its prefix, so no pair of keys changes places.                                  |
| `route-pattern.ts:117`     | 1   | `>` → `>=` in the best-match loop. Two distinct keys cannot tie: equal prefix length and equal exactness make them the same key. This is the "iteration order is irrelevant by construction" claim in that module, confirmed.                                                         |
| `request-path.ts:45`       | 1   | The early exit from the decode loop. Decoding a settled value is idempotent, so running the remaining passes returns the same string.                                                                                                                                                 |
| `vitals-aggregate.ts:111`  | 1   | The upper half of the percentile index clamp. `Math.ceil(p * len) <= len` for any `p <= 1`, so that bound never binds.                                                                                                                                                                |
| `vitals-aggregate.ts:143`  | 1   | `<` → `<=` when scanning for the oldest key. On a `lastSeen` tie it evicts the other equally-old key, which is the same decision.                                                                                                                                                     |
| `vitals-aggregate.ts:149`  | 1   | `if (oldestKey !== undefined)`. Eviction only runs at capacity, so the map is never empty here.                                                                                                                                                                                       |
| `vitals-aggregate.ts:173`  | 1   | **Genuine.** Nothing distinguishes the first fill of a key's sample array from the ring-buffer overwrite that replaces it once full.                                                                                                                                                  |

Two mutants in `dataTable.ts` report as `# errors` and two lines in
`request-path.ts` as `# no cov`; neither counts toward the score.

## Reading a red run

`pnpm test:mutation` fails for one of three reasons, and the report says which:

1. **A test got weaker.** `# killed` drops on a file nobody touched. This is what
   the gate is for.
2. **New code is not pinned down.** `# survived` or `# no cov` rises on a file
   that just changed. Add the assertion.
3. **A refactor moved an equivalent mutant.** `# survived` rises on a file whose
   behaviour did not change. Check it against the table above, add a row, and —
   if the real score has moved — adjust `break` deliberately in the same commit
   that explains why.

Never delete an assertion, loosen a matcher or narrow `mutate` to get back to
green. The first two make the gate measure less; the third makes it measure
nothing.
