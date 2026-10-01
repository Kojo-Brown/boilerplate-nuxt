/**
 * The WCAG 2.2 AA audit, as data.
 *
 * `tests/e2e/a11y.test.ts` drives a browser from this table and `axe-core`
 * reports on each page; `tests/unit/lint/a11y-config.test.ts` audits the table
 * itself against `pages/` and against the rule set axe actually ships. The
 * split is the same one `owasp.config.ts` makes, and for the same reason: a
 * prose accessibility statement reads identically whether its claims are still
 * true or not, so the claim is written as something a test can resolve.
 *
 * ## Why this is a gate and not a report
 *
 * An axe report that nobody fails on is a document that goes stale on the first
 * merge after it was written. The gate is zero violations, with no exemption
 * mechanism — deliberately. A rule that genuinely cannot be satisfied would need
 * whoever hits it to add the escape hatch *and* argue for it in review, which is
 * where that argument belongs. There is no `ignore` list here for the same
 * reason there is no `exclude` selector list: both are places a real violation
 * can sit quietly for a year.
 *
 * ## What the audit cannot see
 *
 * axe finds the machine-checkable subset of WCAG, which is roughly a third of
 * the success criteria. Nothing here says anything about whether a heading
 * describes its section, whether an alternative text is *accurate*, whether a
 * focus order is sensible, or whether an error message is useful. A green gate
 * means the automatable floor holds, not that the app is accessible, and
 * `docs/accessibility.md` says what still has to be checked by hand.
 */

/**
 * The axe-core tags whose union is the WCAG 2.2 Level A + AA rule set.
 *
 * WCAG is cumulative — 2.2 contains all of 2.1, which contains all of 2.0 — so
 * "2.2 AA" is five tags, not one. `wcag22aa` alone selects exactly one rule
 * (`target-size`), which is the mistake that produces a green gate having checked
 * almost nothing.
 *
 * This list is what decides the audit's coverage, so it is checked from both
 * directions in `tests/unit/lint/a11y-config.test.ts`: every tag has to match at
 * least one axe rule (a typo matches none, and axe treats that as "no rules" and
 * not as an error), and the union has to cover every A/AA rule axe implements,
 * found by criterion tag rather than by level tag so a rule with a missing level
 * tag still shows up.
 *
 * `wcag2aaa` is deliberately absent: AAA is not the target, and
 * `color-contrast-enhanced` would fail the whole palette.
 */
export const WCAG_22_AA_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] as const

/**
 * Rules inside the tag set above that axe-core ships with `enabled: false`,
 * stated and turned on explicitly.
 *
 * ## What this is not
 *
 * It is not what gives the gate its WCAG 2.2 coverage, which is the obvious
 * reading and is wrong. Measured against axe-core 4.13 in a browser:
 * `runOnly: { type: 'tag', … }` runs every rule carrying a selected tag
 * *regardless of its default `enabled` flag*. A plain tag-selected run reports
 * `target-size` under `passes` with no `rules` block at all, while a default run
 * (no `runOnly`) omits it. So tag selection already overrides the flag, and this
 * object is belt-and-braces rather than the load-bearing part.
 *
 * ## Why it is still here
 *
 * Because that override is behaviour, not contract. axe's documentation describes
 * `enabled` and `runOnly` independently and says nothing about which wins; the
 * interaction has changed across major versions before, and a release that made
 * tag selection respect the flag would silently delete this gate's only WCAG 2.2
 * rule. Stating the three rules costs nothing, says what the audit means to
 * cover, and survives that change.
 *
 * What actually guarantees the coverage is measured per page at runtime:
 * `tests/e2e/a11y.test.ts` asserts that `target-size` appears in axe's own
 * results, so a configuration that stopped running it fails rather than passing
 * quietly. `tests/unit/lint/a11y-config.test.ts` keeps this list equal to the
 * disabled rules actually inside the tag set, so a future axe release that
 * disables a fourth one lands as a decision rather than as a silently narrower
 * audit.
 *
 * Each key is paired with why axe holds the rule back, because that is what a
 * reader needs in order to judge whether opting in was reasonable.
 */
export const RULES_AXE_SHIPS_DISABLED: Readonly<Record<string, string>> = {
  'target-size':
    'WCAG 2.2 SC 2.5.8 (24×24 CSS px minimum). Held back by axe because the ' +
    'criterion has exceptions — inline links in a sentence, a control whose ' +
    'spacing leaves a 24px circle clear, a size the user agent decides — that ' +
    'axe can only partly reason about, so a project has to opt in. This is the ' +
    'only rule in axe that tests anything WCAG 2.2 added at AA: without it ' +
    'there is no "2.2" in this gate at all.',
  'aria-roledescription':
    'SC 4.1.2. Held back because the rule only fires on an explicit ' +
    '`aria-roledescription`, which most pages never use, so it is pure cost ' +
    'for most consumers. Nothing here sets one, which is exactly why it is ' +
    'cheap to enable and worth having armed before someone does.',
  'audio-caption':
    'SC 1.2.2 (captions for prerecorded audio). Held back because axe cannot ' +
    'tell a decorative `<audio>` from one carrying speech and would need a ' +
    'human to confirm either way. Enabled on the same reasoning as above: ' +
    'there is no `<audio>` element in this app today, so arming the rule costs ' +
    'nothing and catches the first one that lands without a transcript.',
}

/**
 * Rules axe omits from its results entirely, rather than reporting them
 * `inapplicable`, when nothing on the page matched.
 *
 * `tests/e2e/a11y.test.ts` proves, per page, that every rule in the tag set above
 * actually executed — a gate whose whole output is "axe found nothing" has to be
 * able to show that it looked. These five break that check for a benign reason:
 * each has a `matches` filter rather than only a selector, and a rule whose filter
 * admits no candidate is left out of all four result arrays instead of landing in
 * `inapplicable` like a rule whose selector found nothing.
 *
 * Observed, not assumed: all five are absent on every page of this app, and
 * `target-size` — the rule the audit most needs to prove it ran — reports
 * `passes`. The e2e check treats this as an upper bound rather than an exact set,
 * so a page that does have a `<table>` and makes `td-has-header` report is fine,
 * while a *sixth* rule going quiet fails the gate.
 */
export const RULES_OMITTED_WHEN_NOTHING_MATCHES: readonly string[] = [
  // Needs the CSS object model preloaded and a transform to inspect.
  'css-orientation-lock',
  // Only fires on a control whose visible label and accessible name disagree.
  'label-content-name-mismatch',
  // Only fires on a `<p>` styled to look like a heading.
  'p-as-heading',
  // Both only fire inside a `<table>`.
  'table-fake-caption',
  'td-has-header',
]

/**
 * The colour schemes every page is audited in.
 *
 * Both, because contrast is a property of a palette and this app has two: the
 * dark palette is a separate set of token values that no light-mode audit
 * touches. Playwright sets `prefers-color-scheme` per project and
 * `@nuxtjs/color-mode` is configured `preference: 'system'`, so the media query
 * is the whole mechanism — no cookie or `localStorage` priming required.
 */
export const COLOUR_SCHEMES = ['light', 'dark'] as const

export type ColourScheme = (typeof COLOUR_SCHEMES)[number]

/** Whether a route is audited signed out or signed in. */
export type RouteAccess = 'guest' | 'session'

export interface AuditedRoute {
  /** The path to visit. The audit fails if the app navigates somewhere else. */
  readonly path: string
  /** The `pages/` file that serves it, resolved by the unit test. */
  readonly page: string
  /**
   * `guest` routes are audited in a context with no session cookie; `session`
   * routes in one that has signed in. Getting this wrong does not silently
   * audit the wrong page — `middleware/auth.global.ts` redirects, and the audit
   * asserts the landed path.
   */
  readonly access: RouteAccess
}

/**
 * Every route the app serves from `pages/`, and how to reach it.
 *
 * The list is exhaustive by test rather than by intention:
 * `tests/unit/lint/a11y-config.test.ts` walks `pages/` and fails if a file has
 * no entry here. That is what stops a new page from being born exempt — the
 * failure mode of every audit that is maintained as a list someone remembers to
 * update.
 *
 * `access` mirrors `PUBLIC_PATHS` in `middleware/auth.global.ts`, and the unit
 * test checks the two against each other rather than trusting this column.
 */
export const AUDITED_ROUTES: readonly AuditedRoute[] = [
  { path: '/login', page: 'pages/login.vue', access: 'guest' },
  { path: '/islands', page: 'pages/islands.vue', access: 'guest' },
  { path: '/route-rules', page: 'pages/route-rules/index.vue', access: 'guest' },
  { path: '/route-rules/static', page: 'pages/route-rules/static.vue', access: 'guest' },
  // Public because it is `swr`-cached; see middleware/auth.global.ts.
  { path: '/rendering/isr', page: 'pages/rendering/isr.vue', access: 'guest' },

  { path: '/', page: 'pages/index.vue', access: 'session' },
  { path: '/async-data-cache', page: 'pages/async-data-cache.vue', access: 'session' },
  { path: '/cached-functions', page: 'pages/cached-functions.vue', access: 'session' },
  { path: '/custom-ref', page: 'pages/custom-ref.vue', access: 'session' },
  { path: '/data-patterns', page: 'pages/data-patterns.vue', access: 'session' },
  { path: '/dependency-inversion', page: 'pages/dependency-inversion.vue', access: 'session' },
  { path: '/effect-scope', page: 'pages/effect-scope.vue', access: 'session' },
  { path: '/images', page: 'pages/images.vue', access: 'session' },
  { path: '/reactivity-performance', page: 'pages/reactivity-performance.vue', access: 'session' },
  { path: '/reactivity-pitfalls', page: 'pages/reactivity-pitfalls.vue', access: 'session' },
  { path: '/render-functions', page: 'pages/render-functions.vue', access: 'session' },
  { path: '/rendering', page: 'pages/rendering/index.vue', access: 'session' },
  { path: '/rendering/spa', page: 'pages/rendering/spa.vue', access: 'session' },
  { path: '/rendering/ssg', page: 'pages/rendering/ssg.vue', access: 'session' },
  { path: '/rendering/ssr', page: 'pages/rendering/ssr.vue', access: 'session' },
  { path: '/streaming', page: 'pages/streaming.vue', access: 'session' },
  { path: '/ui-primitives', page: 'pages/ui-primitives.vue', access: 'session' },
  { path: '/upload', page: 'pages/upload.vue', access: 'session' },
  { path: '/websockets', page: 'pages/websockets.vue', access: 'session' },
]
