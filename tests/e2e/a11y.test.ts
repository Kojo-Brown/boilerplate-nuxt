import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import axe, { type AxeResults, type Result } from 'axe-core'

import {
  AUDITED_ROUTES,
  RULES_AXE_SHIPS_DISABLED,
  RULES_OMITTED_WHEN_NOTHING_MATCHES,
  WCAG_22_AA_TAGS,
  type AuditedRoute,
} from '../../a11y.config'

/**
 * The WCAG 2.2 AA gate: zero axe violations on every page, in both palettes.
 *
 * What to audit is `a11y.config.ts`; this file is only how. Run it with
 * `pnpm test:a11y`, which builds first — see `playwright.a11y.config.ts` for why
 * the audit runs against the build rather than against `pnpm dev`.
 */

/** A session-less context for the routes a signed-out visitor sees. */
const SIGNED_OUT = { cookies: [], origins: [] }

function auditOf(page: Page): AxeBuilder {
  return new AxeBuilder({ page }).options({
    runOnly: { type: 'tag', values: [...WCAG_22_AA_TAGS] },
    // `options()` rather than `withTags()` because the two do not compose:
    // `withTags` sets `runOnly` itself and would discard the `rules` block below.
    // Both are passed in one object instead.
    //
    // The `rules` block states the three rules axe ships disabled; see
    // `a11y.config.ts` for why it is belt-and-braces rather than the thing that
    // gives this audit its WCAG 2.2 coverage, and `expectAuditActuallyRan` for
    // what does.
    rules: Object.fromEntries(
      Object.keys(RULES_AXE_SHIPS_DISABLED).map((id) => [id, { enabled: true }]),
    ),
    // Violations are the gate. Asking for passes and incompletes as well makes
    // axe serialise every node it looked at across the CDP boundary, which on
    // the larger demo pages is most of the run time.
    resultTypes: ['violations'],
  })
}

/** The failure message: every node, with the selector and axe's own reason. */
function describe(results: AxeResults): string {
  return results.violations.map(describeViolation).join('\n\n')
}

function describeViolation(violation: Result): string {
  const nodes = violation.nodes
    .map((node) => {
      const summary = (node.failureSummary ?? '').replace(/\s+/g, ' ').trim()
      return `    at ${node.target.join(' ')}\n      ${node.html.slice(0, 200)}\n      ${summary}`
    })
    .join('\n')

  return [
    `  ${violation.id} (${violation.impact ?? 'no impact'}) — ${violation.help}`,
    `  ${violation.helpUrl}`,
    nodes,
  ].join('\n')
}

/**
 * Loads a route and leaves the page settled enough to measure.
 *
 * The landed path is asserted rather than assumed. Auditing the wrong page is
 * the one failure this suite cannot detect from its own results: a route whose
 * `access` is wrong in `a11y.config.ts`, or one that `middleware/auth.global.ts`
 * redirects for any other reason, would be reported green on the strength of a
 * clean audit of the login form twenty-four times over.
 */
async function visit(page: Page, route: AuditedRoute): Promise<void> {
  await page.goto(route.path, { waitUntil: 'networkidle' })

  // Trailing slashes are the router's business, not this gate's.
  const landed = new URL(page.url()).pathname.replace(/(.)\/$/, '$1')
  expect(landed, `${route.path} navigated to ${landed}`).toBe(route.path)

  await settle(page)
}

/**
 * Waits until the browser has nothing left to paint.
 *
 * `networkidle` says the network is quiet, not that Vue has finished with the
 * DOM — a `<Suspense>` boundary or a CSS transition can still be mid-flight, and
 * the contrast rule measures an element at 40% opacity as the colour it is at
 * that instant. Two animation frames is the cheapest honest answer: the first
 * resolves after the frame already pending, the second after the one any effect
 * in that frame scheduled.
 */
async function settle(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))),
  )
}

async function expectNoViolations(page: Page, label: string): Promise<void> {
  const results = await auditOf(page).analyze()

  expectAuditActuallyRan(results, label)

  // Asserted as a list of `rule (n nodes)` strings rather than on
  // `results.violations` directly. The objects carry every matched node with its
  // full `any`/`all`/`none` check tree, and a failing `toEqual([])` on them
  // prints a two-hundred-line diff that buries the message below. The detail is
  // in the message; the diff just needs to name what failed.
  const summary = results.violations.map(
    (violation) =>
      `${violation.id} (${violation.nodes.length} ${violation.nodes.length === 1 ? 'node' : 'nodes'})`,
  )

  expect(summary, summary.length === 0 ? '' : `${label}\n${describe(results)}`).toEqual([])
}

/**
 * The audit measured what it claims to measure.
 *
 * Every assertion in this file is "axe found nothing", and the cheapest way to
 * satisfy that is to run no rules — a mistyped tag, a `withTags` call that
 * discarded the `rules` block, a release that moved a rule into the disabled set.
 * `tests/unit/lint/a11y-config.test.ts` guards the configuration; this guards the
 * run, from inside the browser that performed it, which is the only place the
 * answer is a fact rather than an inference.
 *
 * axe reports a rule under exactly one of the four result arrays — including
 * `inapplicable` for a rule that found no matching element — so a rule absent
 * from all four did not execute.
 */
function expectAuditActuallyRan(results: AxeResults, label: string): void {
  const executed = new Set(
    [...results.violations, ...results.passes, ...results.incomplete, ...results.inapplicable].map(
      (result) => result.id,
    ),
  )

  const expected = axe.getRules([...WCAG_22_AA_TAGS]).map((rule) => rule.ruleId)
  const silent = expected
    .filter((id) => !executed.has(id))
    .filter((id) => !RULES_OMITTED_WHEN_NOTHING_MATCHES.includes(id))

  expect(
    silent,
    `${label}: ${silent.length} rule(s) in the WCAG 2.2 AA set reported nothing at all — ` +
      `the gate would be reporting clean on rules it never evaluated:\n  ${silent.join('\n  ')}`,
  ).toEqual([])

  // The positive half, and the one that matters most. `target-size` is the only
  // rule axe implements for a criterion WCAG 2.2 introduced at AA, it is the one
  // rule in the set that axe ships disabled *and* that always has nodes (it
  // matches every interactive control), and so it is the single observation that
  // distinguishes a real WCAG 2.2 audit from a WCAG 2.1 audit wearing the name.
  // Checked in the failing direction by disabling it: the rule disappears from all
  // four result arrays and this line is what reports it.
  expect(executed, `${label}: target-size did not run — this is not a WCAG 2.2 audit`).toContain(
    'target-size',
  )

  // The rule metadata above comes from the `axe-core` this process imported; the
  // run came from the copy `@axe-core/playwright` injected. They are the same
  // package in `pnpm-lock.yaml`, and this is what keeps that true — a resolution
  // that split them would make every claim in the unit test about a different
  // engine than the one that produced these results.
  expect(results.testEngine.version, `${label}: axe version mismatch`).toBe(axe.version)
}

for (const access of ['guest', 'session'] as const) {
  const routes = AUDITED_ROUTES.filter((route) => route.access === access)

  test.describe(`${access} routes`, () => {
    // Guest routes drop the session the setup project saved. `test.use` rather
    // than a hand-built context so the project's `colorScheme` survives.
    if (access === 'guest') test.use({ storageState: SIGNED_OUT })

    for (const route of routes) {
      test(`${route.path} has no WCAG 2.2 AA violations`, async ({ page }) => {
        await visit(page, route)
        await expectNoViolations(page, `${route.path} (${route.page})`)
      })
    }
  })
}

/**
 * States a route-level sweep cannot reach.
 *
 * Everything above audits a page as it loads. A dialog that is closed, a toast
 * that has not fired and a disclosure that is collapsed are not in the document
 * at all, so their markup is never measured — and a modal is exactly where focus
 * trapping, `aria-modal` and a missing accessible name go wrong. These are
 * written out rather than driven from the config table because an interaction is
 * code, and pretending otherwise would mean inventing a little language for
 * clicks in a data file.
 */
test.describe('interactive states', () => {
  const UI_PRIMITIVES: AuditedRoute = {
    path: '/ui-primitives',
    page: 'pages/ui-primitives.vue',
    access: 'session',
  }

  test('the modal is accessible while open', async ({ page }) => {
    await visit(page, UI_PRIMITIVES)

    await page.getByRole('button', { name: 'Basic Modal' }).click()
    await expect(page.getByRole('dialog')).toBeVisible()
    // The open transition animates opacity and scale. Measuring contrast
    // half-way through it reports the interpolated colour, which is a different
    // number on a loaded runner than on an idle one.
    await settle(page)

    await expectNoViolations(page, '/ui-primitives with the modal open')
  })

  test('a toast is accessible while shown', async ({ page }) => {
    await visit(page, UI_PRIMITIVES)

    // "Persistent" rather than one of the four that auto-dismiss: those are
    // raised with a timeout, and an audit that takes longer than it on a slow
    // runner would measure an empty live region and pass having seen no toast.
    await page.getByRole('button', { name: 'Persistent' }).click()
    await expect(page.getByText('This toast will not auto-dismiss.')).toBeVisible()
    await settle(page)

    await expectNoViolations(page, '/ui-primitives with a toast shown')
  })
})

/**
 * The second locale.
 *
 * `@nuxtjs/i18n` is configured `prefix_except_default`, so French lives under
 * `/fr`. One route is enough: what varies by locale is the `lang` attribute and
 * the translated strings, and `html-has-lang` / `html-lang-valid` / `valid-lang`
 * are the rules that care. Auditing all twenty-four paths twice more would double
 * the run to re-measure the same components.
 *
 * `/fr/` rather than `/fr/login`, and it keeps the session: `PUBLIC_PATHS` in
 * `middleware/auth.global.ts` holds unprefixed paths, so `/fr/login` is not in it
 * and a signed-out visitor asking for the French login form is redirected to the
 * English one. That is a real bug and it is not this change's to fix — it is a
 * routing defect rather than an accessibility one, and fixing it means deciding
 * how that table should treat locale prefixes. Noted here because the next person
 * to add a `/fr` route to this audit will hit it.
 */
test.describe('localised routes', () => {
  test('/fr/ has no WCAG 2.2 AA violations and declares its language', async ({ page }) => {
    await page.goto('/fr/', { waitUntil: 'networkidle' })
    expect(new URL(page.url()).pathname).toBe('/fr/')

    // `fr-FR`, the BCP 47 `language` from the locale table — not the `fr` URL
    // prefix. `html-lang-valid` accepts either, so only this says which one the
    // app actually ships.
    await expect(page.locator('html')).toHaveAttribute('lang', 'fr-FR')
    await settle(page)

    await expectNoViolations(page, '/fr/')
  })
})
