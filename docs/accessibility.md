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

Two criteria are worth calling out as unmeasurable by axe, which has no rule for
either: **SC 2.4.3 Focus Order** and **SC 4.1.3 Status Messages**. They are
covered, by behaviour rather than by markup — see the next section.

## SPA navigation: focus and announcements

A full page load hands the user a new document. The browser resets focus to the
start of it and a screen reader reads the new `<title>`, and neither is something
an app has to arrange. A client-side navigation does neither, because the document
never changes: focus stays on the link that was clicked — or falls to `<body>` if
that link was unmounted — and nothing is announced. The page looks replaced and,
to a keyboard or screen reader user, is not.

Nothing in the axe gate above can see this. The markup of both pages is
impeccable; the defect is in what happened _between_ them. So this half is
asserted behaviourally, in the same CI job, under
`test.describe('SPA navigation')` in `tests/e2e/a11y.test.ts`.

| Piece                                 | What it holds                                                       |
| ------------------------------------- | ------------------------------------------------------------------- |
| `utils/routeNavigation.ts`            | Which navigations count, and when to stand down — as pure functions |
| `composables/useRouteChangeA11y.ts`   | The router subscription and the `focus()` call                      |
| `composables/useRouteAnnouncement.ts` | The live region's message                                           |
| `components/AppRouteAnnouncer.vue`    | The live region itself                                              |
| `components/AppSkipLink.vue`          | The bypass block (SC 2.4.1)                                         |
| `app.vue`                             | `<main id="main-content" tabindex="-1">`, and the one call          |
| `tests/unit/lint/page-titles.test.ts` | Every page named, and no two named the same                         |

### What happens on a navigation

Focus moves to `<main id="main-content">`, and the new page's name goes into a
polite live region. `<main>` carries `tabindex="-1"` because that is what makes it
a legal focus target at all: `element.focus()` on a non-focusable element silently
does nothing, and a browser moves focus to the target of an in-page link only when
that target is focusable. `-1` keeps it out of the `Tab` sequence, so the page
gains no extra stop.

It is the same target the skip link points at, deliberately — one behaviour to
learn rather than two. The focus call passes `preventScroll: true`, because
scrolling is the router's job and it has already done it: top of the page on a
push, the saved position on a back or forward. Without the flag, focusing scrolls
the element into view and undoes the restore, dropping the user at the top of a
page they were half way down.

### Three navigations that are deliberately left alone

Each of these is a bug if treated as a page change, and each has a test in
`tests/unit/utils/routeNavigation.test.ts` naming it:

- **The first navigation** (hydration). The browser has already placed focus, and
  the screen reader has already read the title it was served. Recognised by
  `from.matched` being empty — vue-router's `START_LOCATION` — rather than by a
  "have we navigated yet" flag, which would only be correct if these hooks were
  registered before the first navigation, and Nuxt resolves that one during plugin
  setup.
- **A hash-only change.** In-page navigation: the browser moves to the fragment
  and takes focus with it. This is also what the skip link does, so treating it as
  a page change would announce the page the user is already on.
- **A query-only change.** `?page=2`, `?sort=name`, `?q=…` are written by a control
  the user is still operating. Pulling focus out of a filter box on every keystroke
  is worse than doing nothing, and the state it changed is a status message for the
  component that owns it to announce.

So the comparison is on `path` alone. `fullPath` would make every query change a
navigation; comparing matched route records would miss `/a` → `/b` when both
resolve to the same component.

### When the page wants focus somewhere else

A page that focuses its own first field on mount — a search page, a login form, a
composer — wins. `navigationClaimedFocus` compares what held focus when the
navigation started against what holds it after the render: if they differ and the
new one is still mounted, something took focus on purpose and the reset stands
down.

Comparing against the _start_ is what makes the ordinary case work. After a link
click the clicked link still holds focus, and if it survives the navigation (a
persistent nav, a card grid re-rendered in place) then nothing has claimed
anything and the reset must proceed — even though there is a perfectly normal
focused element sitting there.

The reset does not have to know which of the two ran first, because both orderings
land on the page's choice. Vue flushes the navigation's render before `nextTick`
resolves when the page is synchronous, so the reset sees the page's element
already focused and declines; it resolves first when the page suspends on data, so
the reset runs and the page's own `onMounted` overwrites it.

### Why the announcement is not `<NuxtRouteAnnouncer />`

Nuxt ships one, and this app used it. It announces `document.title`, re-read on
unhead's `dom:rendered` hook, and that is the wrong mechanism here on two counts.
It is driven by the title rather than by navigation — `dom:rendered` fires on any
head change and not at all on a navigation that leaves the head alone, so it
cannot tell a page change from a `useSeoMeta` update, and has no way to know a
navigation was hash-only. And it announces the whole document title, which here is
`<page> · Nuxt 4 Boilerplate`, so every announcement would repeat the product name.

It was also silent on half the app, which is the more interesting failure.

### The announcer's one hard requirement: distinct titles

A live region fires on a **change** to its contents. Assigning the string it
already holds changes nothing — Vue does not re-render, the text node is not
touched, and the screen reader says nothing. Not a mutation it ignores: no
mutation.

Twelve of this app's twenty-four pages declared no `definePageMeta({ title })`, so
every one of them fell back to the same `titleTemplate` default. Navigating between
any two of them announced nothing, while looking in the markup exactly like a
working announcer. The same twelve also shared one `<title>`, which is SC 2.4.2
failed in substance while `document-title` — axe only checks that the element is
non-empty — reported clean on all of them.

All twenty-four now name themselves, and `tests/unit/lint/page-titles.test.ts`
fails `pnpm test` if a page declares no title or if two pages share one. That gate
is what makes the live region reliable for every route in `pages/`, which is why
`useRouteAnnouncement` can take the cheap single-write path and never flicker an
empty region through a frame. It still handles a repeat — by clearing the region
and letting a render happen before writing the same text again — because a dynamic
route (`/orders/[id]`) would reintroduce the case and no lint rule can see it.

### Known gaps

- **Page titles are not translated.** `definePageMeta` is a compiler macro, so its
  argument cannot call `t()`. The sentence around the title is a locale string
  (`a11y.navigatedTo`) and the title inside it stays English in both locales. The
  document `<title>` has had the same gap since it started working.
- **A locale switch moves focus.** `/rendering` → `/fr/rendering` is a path change,
  so it announces and resets focus — out of the `<select>` that caused it. Taken
  deliberately: every string on the page has just been replaced, which is closer to
  a new page than to a filter change.
- **Focus is not restored per history entry.** Back and forward reset focus to the
  top like any other navigation rather than returning it to the element that had it
  when that entry was left. Doing it properly means keeping a focus position per
  history entry, and the elements it would name do not survive the remount, so it
  needs a selector strategy rather than a reference. `preventScroll` keeps the
  scroll restoration intact in the meantime.
- **`<main>` shows a focus ring in some browsers.** Chrome does not apply
  `:focus-visible` to a programmatically focused `tabindex="-1"` element, so the
  reset is invisible; activating the skip link is a user gesture and may paint an
  outline around the whole content area. Nothing suppresses it, because suppressing
  a focus indicator is how SC 2.4.7 gets failed somewhere else later.
- **The fixed control cluster is outside any landmark.** `<main>` now wraps the
  page, but the language switcher and colour-mode toggle sit before it in a bare
  `<div>`. axe's `region` rule is tagged best-practice rather than WCAG, so the
  gate above does not run it; a `<header>` around that cluster is the fix, and it
  is a layout decision rather than this change's.
