# Accessibility: the WCAG 2.2 AA gate

`pnpm test:a11y` builds the app, serves the build, and runs axe-core over every
page in both colour schemes. Zero violations, or the job fails.

```
pnpm test:a11y     # nuxt build && playwright test --config=playwright.a11y.config.ts
```

CI runs it as its own job on every pull request (`.github/workflows/ci.yml`).

| Piece                                 | What it holds                                              |
| ------------------------------------- | ---------------------------------------------------------- |
| `a11y.config.ts`                      | The tag set, the route table, the colour schemes — as data |
| `tests/e2e/a11y.test.ts`              | The browser run: the gate itself                           |
| `tests/e2e/a11y.setup.ts`             | Signs in once; the audit projects reuse the session        |
| `playwright.a11y.config.ts`           | One project per colour scheme, served from `.output/`      |
| `tests/unit/lint/a11y-config.test.ts` | Audits the audit; runs in `pnpm test`                      |

## What "WCAG 2.2 AA" means to axe

Five tags, because WCAG is cumulative — 2.2 contains 2.1, which contains 2.0:

```
wcag2a  wcag2aa  wcag21a  wcag21aa  wcag22aa
```

Seventy rules. `wcag22aa` on its own selects **one** of them (`target-size`), so
an audit configured with that tag alone passes having checked almost nothing.
`wcag2aaa` is excluded: AAA is not the target, and `color-contrast-enhanced`
(7:1) would fail the whole palette.

Three rules in that set ship `enabled: false` in axe-core and are named
explicitly in `RULES_AXE_SHIPS_DISABLED`: `target-size` (SC 2.5.8),
`aria-roledescription` and `audio-caption`. Measured against axe-core 4.13,
`runOnly: { type: 'tag', … }` runs a tagged rule _regardless_ of that flag — a
plain tag-selected run reports `target-size` under `passes` with no `rules` block
at all, where a default run omits it. So the opt-in is belt-and-braces, not the
mechanism: axe documents `enabled` and `runOnly` independently and promises
nothing about which wins, and a release that changed it would delete this gate's
only WCAG 2.2 rule.

What actually guarantees the coverage is checked at runtime, per page, inside the
browser that did the run: `expectAuditActuallyRan` asserts every rule in the tag
set reported _something_ — axe files a rule it had nothing to apply to under
`inapplicable`, so a rule absent from all four result arrays did not execute —
and asserts specifically that `target-size` ran. Without that line, "2.2" in the
suite's name would be unverified.

Five rules are allowed to report nothing (`RULES_OMITTED_WHEN_NOTHING_MATCHES`):
`css-orientation-lock`, `label-content-name-mismatch`, `p-as-heading`,
`table-fake-caption` and `td-has-header`. Each has a `matches` filter rather than
only a selector, and axe leaves such a rule out of all four arrays when its filter
admits no candidate instead of filing it `inapplicable`. The check treats the list
as an upper bound, so a page that does have a `<table>` is fine and a _sixth_ rule
going quiet fails.

## Why the audit runs against the build

`playwright.config.ts` drives `pnpm dev`; this suite serves `.output/` and
deliberately does not reuse it:

- **`pnpm dev` injects Nuxt DevTools.** Its toolbar is part of the document axe
  sees and has contrast failures of its own. Auditing the dev server means either
  reporting violations in a toolbar that never ships, or adding an `exclude`
  selector — and an exclude list is somewhere a real violation can sit for a year.
- **The dev CSP is weaker and the dev stylesheet is injected from JavaScript.**
  Contrast is measured on computed style, so what gets audited should be the
  stylesheet that gets deployed.
- **Prerendered routes only exist in a build.** `/route-rules/static` is written
  as static HTML at build time; the dev renderer serves something else.

The audit needs **no database**. The only page that can read one
(`/dependency-inversion`) defaults to its in-memory gateway, so CI starts no
Postgres service; `playwright.a11y.config.ts` sets `NUXT_OUTBOX_RELAY_ENABLED=false`
so the relay does not fill the job log with connection failures and bury a real
one.

A note for anyone adding an audit here: axe is injected with `page.evaluate`, not
`addScriptTag`. This app sends a strict nonce-based CSP, and an injected
`<script>` tag is refused by it — `@axe-core/playwright` goes through the CDP
runtime, which the policy does not gate. A hand-rolled `addScriptTag` audit fails
with a CSP error on every page that is not prerendered.

## Both colour schemes

Contrast is a property of a palette, and `assets/css/tailwind.css` has two: every
`--color-*` is redefined under `.dark`. A light-only audit measures none of those
values. Playwright sets `prefers-color-scheme` per project and
`@nuxtjs/color-mode` is configured `preference: 'system'`, so the media query is
the whole mechanism — no cookie or `localStorage` priming.

This was not theoretical. The dark palette's `--color-primary` was `#6366f1`
with white text at **4.46:1**, so every primary button in dark mode was under AA,
and the same value as link text on `--color-muted` was 3.33:1. A light-only gate
would have shipped both.

## The palette, measured

Every pair below clears 4.5:1 (AA for body text) on every surface it is used on.
Change a value without running `pnpm test:a11y` and you are guessing.

| Token                        | Light     | on bg             | on muted | Dark      | on bg             | on muted |
| ---------------------------- | --------- | ----------------- | -------- | --------- | ----------------- | -------- |
| `--color-foreground`         | `#0a0a0a` | 19.80:1           | 18.01:1  | `#fafafa` | 19.06:1           | 14.27:1  |
| `--color-muted-foreground`   | `#52525b` | 7.73:1            | 7.03:1   | `#a1a1aa` | 7.76:1            | 5.81:1   |
| `--color-primary` (as text)  | `#4f46e5` | 6.29:1            | 5.72:1   | `#818cf8` | 6.67:1            | 4.99:1   |
| `--color-primary-foreground` | `#ffffff` | 6.29:1 on primary |          | `#09090b` | 6.67:1 on primary |          |
| `--color-success`            | `#016630` | 7.13:1            | 6.49:1   | `#05df72` | 11.18:1           | 8.37:1   |
| `--color-danger`             | `#c10007` | 6.42:1            | 5.84:1   | `#ff6467` | 6.89:1            | 5.16:1   |
| `--color-warning`            | `#973c00` | 7.09:1            | 6.45:1   | `#ffb900` | 11.55:1           | 8.65:1   |

`--color-success` / `--color-danger` / `--color-warning` exist because the
contrast question is "is this readable on our surfaces", which is a property of
the palette and answerable once — not twenty-five times in markup, where the next
person reaches for the shade that looks right. `text-red-600` on
`--color-muted` is 4.34:1; it was in use in eleven places.

There is **no exemption mechanism** — no `ignore` list, no `exclude` selectors.
A rule that genuinely cannot be satisfied needs whoever hits it to add the escape
hatch _and_ argue for it in review, which is where that argument belongs.

## Adding a page

Add it to `AUDITED_ROUTES` in `a11y.config.ts`. You do not have to remember to:
`tests/unit/lint/a11y-config.test.ts` walks `pages/` and fails `pnpm test` if a
file has no entry, which is what stops a new page being born exempt. `access`
(`guest` / `session`) is checked against `PUBLIC_PATHS` in
`middleware/auth.global.ts`, and the browser run asserts the path it landed on —
so a route that redirects fails instead of being reported green on a clean audit
of the login form.

A dynamic route (`[id].vue`) throws from the test's `routeForPage` helper rather
than being guessed at: it needs a concrete path to visit, and that is a decision
for whoever adds the first one.

## What the gate found

Beyond the palette, the first run reported 24 pages failing on four rules each:

- **`html-has-lang` (SC 3.1.1)** and **`document-title` (SC 2.4.2)** on every
  page — there was no `<html lang>` and no `<title>` anywhere. `lang` is the one
  that changes behaviour: without it a screen reader reads the page in whatever
  voice it was last using, so the French routes were pronounced as English. Both
  are fixed in `app.vue`; see the note there on why `useLocaleHead()` is not
  used.
- **`aria-prohibited-attr`** on the toast container — `aria-label` on a `div`
  with no role is prohibited, which also means the label was being discarded and
  the live region was announcing out of an unnamed container.
- **`select-name`** on two `<select>`s that had a visible `<label>` next to them
  and no `for`/`id` tying the two together.
- **`scrollable-region-focusable` (SC 2.1.1)** on the code blocks in server-island
  prose: `overflow-x: auto` with nothing focusable, so they could only be read
  with a pointer.

It also found two defects that are not accessibility failures at all, because it
asserts the path it landed on:

- **`/rendering/isr` was unreachable for everyone.** It carries `swr: 60`, and
  Nitro renders a cached route through its cache layer rather than through the
  request, so the SSR pass had no session and the route guard answered with a
  redirect to `/login` — which the cache then served to everybody for sixty
  seconds, signed-in visitors included. Fixed by making it public, which is the
  same reasoning already written for the prerendered route: shared bytes cannot
  depend on who asked for them.
- **`/fr/login` redirects to `/login`.** `PUBLIC_PATHS` holds unprefixed paths,
  so every localised route is treated as private and a signed-out visitor cannot
  reach the French login form. Still open — it is a routing defect, and fixing it
  means deciding how that table should treat locale prefixes. The localised audit
  uses `/fr/` with a session to work around it.

## What this does not tell you

axe covers the machine-checkable part of WCAG — roughly a third of the success
criteria. A green gate says the automatable floor holds. It says nothing about
whether a heading describes its section, whether alternative text is _accurate_,
whether the focus order follows the visual one, whether an error message helps,
or whether any of this works with a screen reader. Those need a person. Start
with: tab through each page and watch where focus goes, then read the page with
VoiceOver or NVDA with the screen off.

Two criteria are worth calling out as deliberately unmeasured here. **SC 2.4.3
Focus Order** and **SC 4.1.3 Status Messages** are the next spec item (focus
management and route-change announcements for SPA navigation) and axe has no rule
for either.
