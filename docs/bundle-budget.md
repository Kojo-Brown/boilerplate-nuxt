# Bundle budgets: what each route actually costs

`nuxt build` prints one size for the client bundle, and it is the least useful
number available: no visitor ever downloads it. A Nuxt page load fetches the
entry chunk, the chunk for the page being rendered, and the static imports of
both — a few percent of the total on a large app. That per-route figure is what
someone waits for on a phone on a train, and nothing in the toolchain reports
it, so a component that quietly drags a date library into the shared closure
looks exactly like one that does not.

This is the gate that reports it and fails when it grows.

```
nuxt build
  │
  ├─ build:manifest ──▶ modules/bundle-budget.ts
  │                       writes .bundle-budget/client-manifest.json
  │
  └─ .output/public/_nuxt/*.js,*.css
                          │
pnpm bundle:budget        ▼
  scripts/assert-bundle-budget.ts     ← reads both, gzips every file
    ├─ scripts/bundleBudget.ts        ← entry closure + page closure per route
    ├─ bundle-budget.config.ts        ← the ceilings
    └─ exit 1 on any violation, + report.json + a job summary table
```

| File                                      | What it owns                                              |
| ----------------------------------------- | --------------------------------------------------------- |
| `modules/bundle-budget.ts`                | Persisting the client manifest during the build           |
| `scripts/bundleBudget.ts`                 | The manifest walk, the split, the verdicts, the table     |
| `scripts/assert-bundle-budget.ts`         | Filesystem, gzip, the document cross-check, the exit code |
| `bundle-budget.config.ts`                 | One budget line per route, plus the shared baseline       |
| `tests/unit/bundle-budget-config.test.ts` | That the table still covers exactly the pages on disk     |

## What is being measured

For a route, the initial payload is:

- the **entry chunk** and everything it statically imports, transitively —
  Vue, the Nuxt runtime, vue-router, vue-i18n, Pinia, the color-mode plugin,
  the app shell, plus `entry.css`;
- the **page chunk** and everything _it_ statically imports, transitively,
  plus any CSS attached to those chunks.

That is exactly the set of `<link rel="modulepreload">` and
`<link rel="stylesheet">` tags Nuxt writes into the document, because it is the
same graph Nuxt's renderer walks to emit them.

Three things are deliberately excluded:

- **Dynamic imports.** The entry chunk dynamically imports every page and both
  locale files, and Nuxt emits those as `rel="prefetch"` — fetched at idle,
  after the page is interactive. Counting them would give every route the same
  number, the whole application, and the report would stop saying anything
  about the route.
- **Server islands and lazy components.** Same mechanism: an island's chunk is
  fetched by the island endpoint, not by the document.
- **The `__NUXT__` payload.** That is per-request data, not build output. It
  has its own tooling in `utils/payloadBudget.ts` and its own docs in
  `docs/async-data-caching.md`.

Sizes are **gzipped**. Raw size is what a minifier reports; gzip is what crosses
the wire, and the two move independently — generated code can add 30 kB raw and
2 kB gzipped. Brotli would be closer still for a CDN deployment, but gzip is
available in every Node the CI matrix runs and is the conservative of the two.
Raw totals are printed beside the gzipped ones for reference.

## The two budgets per route

```ts
'/upload': { totalGzipBytes: kB(147), routeGzipBytes: kB(2.5) },
```

- `totalGzipBytes` — the whole initial payload, shared baseline included. The
  number a visitor waits for.
- `routeGzipBytes` — what this route adds on top of the baseline. The number
  that page's author controls.

They fail for different reasons, which is the point of having both. A page that
imports a charting library breaks its own line. A component added to `app.vue`
or a store every page touches breaks the shared baseline — and the gate says
which of the two happened instead of reporting twenty-three failures with one
cause.

Every number is what the route measured when the budget was written, plus the
larger of 5% and 2 kB (512 B for a route's own share). The absolute floor is
there because the route-only figures are small: 5% of 1.05 kB is 54 bytes,
inside the range two Node majors' zlib builds can differ by, and a gate that
fails on compressor noise gets muted rather than fixed.

## Running it

```bash
pnpm build          # writes .output/ and .bundle-budget/client-manifest.json
pnpm bundle:budget  # prints the table, exits 1 on any violation
```

The script takes an optional project root, so a build from elsewhere can be
measured: `pnpm bundle:budget path/to/checkout`.

```
Route                    Total gzip    Budget  Route-only gzip   Budget  Raw total
───────────────────────  ──────────  ────────  ───────────────  ───────  ─────────
/dependency-inversion      145.3 kB  153.0 kB          7.60 kB  8.25 kB   405.5 kB
/islands                   144.3 kB  152.0 kB          6.58 kB  7.25 kB   400.1 kB
…
Shared baseline: 137.7 kB gzipped (385.2 kB raw) across 21 files, budget 145.0 kB
```

In CI it runs in the `build` job on every Node major in the matrix, writes
`.bundle-budget/report.json` as an artifact, and appends the same table to the
GitHub job summary so a PR shows its payload without anyone opening a log.

## What fails the gate

| Violation          | What happened                                                        |
| ------------------ | -------------------------------------------------------------------- |
| `over-budget`      | A route, or the shared baseline, exceeded its ceiling                |
| `unbudgeted-route` | A page exists with no line in `bundle-budget.config.ts`              |
| `stale-budget`     | A budget line names a route this build does not serve                |
| `model-drift`      | The computed payload disagrees with a document the build wrote       |
| `manifest`         | The manifest names a chunk that is not on disk, or two pages collide |

The last two are the ones worth explaining.

**`model-drift`** is what keeps this honest. Everything here assumes "entry
closure plus page closure" is what a Nuxt document preloads. If a Nuxt upgrade
changes how the renderer walks the manifest, that assumption becomes wrong
_silently_ and every number in the report drifts with it. So every run diffs the
computed asset set for `/route-rules/static` — the one prerendered route, see
`route-rules.config.ts` — against the `<link>` tags in the HTML the build
actually wrote, and fails on any difference. A gate that is confidently wrong is
worse than no gate.

**`unbudgeted-route` and `stale-budget`** are the same failure in opposite
directions: the table is meant to be a complete, current list of what this
application ships. A budget that silently stops applying, because a page was
renamed, still reads like coverage without being any.
`tests/unit/bundle-budget-config.test.ts` catches both in `pnpm test`, seconds
in, rather than several minutes into the build job.

## When it fails

1. **Read the report.** `.bundle-budget/report.json` lists every asset in every
   route's payload, so the diff between "before" and "after" is a `jq` away.
2. **Decide whether the growth was intended.** If the route genuinely needs the
   dependency, raise its line and say why in the commit — it reads in review as
   what it is, a decision to ship more JavaScript. Never raise a budget to make
   an unexplained regression go away.
3. **If it was not intended**, the usual causes are a static import that should
   have been dynamic (`defineAsyncComponent`, or a `components/islands/`
   component), a barrel file pulling in a package's whole surface, or something
   imported into `app.vue`, a plugin or a store, which puts it in the shared
   baseline for every route at once.

## Adding a page

Add the page, run `pnpm build && pnpm bundle:budget`, and copy the measured
numbers into `bundle-budget.config.ts` with the headroom described above. The
gate fails until you do, which is the intended order: a page whose cost nobody
has looked at is exactly the page this tooling exists for.
