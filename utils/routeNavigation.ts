/**
 * What a client-side navigation means for focus and for a screen reader, as
 * pure functions.
 *
 * A full page load hands the user a new document: the browser resets focus to
 * the start of it, and a screen reader reads the new `<title>`. A client-side
 * navigation does neither — the document never changes, so focus stays wherever
 * it was and nothing is announced. That is the gap `useRouteChangeA11y` closes,
 * and these are the decisions it makes. They live here, with no Vue and no DOM
 * in sight, because each one is a judgement that deserves a test naming the case
 * rather than a branch buried in a router hook.
 *
 * The two criteria at stake are the two WCAG 2.2 AA criteria `axe` has no rule
 * for, which is why `docs/accessibility.md` calls them out as deliberately
 * unmeasured by the audit:
 *
 *  - **SC 2.4.3 Focus Order.** Focus has to end up somewhere that makes the next
 *    `Tab` press mean what the user expects. After a navigation that is the top
 *    of the new page, not the link that caused it.
 *  - **SC 4.1.3 Status Messages.** "You are now on a different page" is a status
 *    message, and a live region is how one is delivered without moving focus.
 */

/**
 * The id of the element `app.vue` renders every page into.
 *
 * One constant rather than a string in three files: it is the skip link's
 * target, the element focus is moved to after a navigation, and the thing
 * `tests/e2e/a11y.test.ts` asserts about. A typo in any one of them is a
 * silently dead feature — the skip link would scroll nowhere and the focus reset
 * would find nothing — so they all read it from here.
 */
export const MAIN_CONTENT_ID = 'main-content'

/** The part of a resolved route these decisions read. */
export interface NavigationTarget {
  readonly path: string
  /**
   * The route records the path matched. Empty only for `START_LOCATION`, which
   * is what {@link isPageNavigation} uses to recognise the first navigation.
   */
  readonly matched: readonly unknown[]
  readonly meta: Readonly<Record<string, unknown>>
}

/**
 * Whether a navigation is the kind that replaces the page.
 *
 * Three cases are deliberately *not* page navigations, and each one is a bug if
 * treated as one:
 *
 *  - **The first navigation.** `from` is vue-router's `START_LOCATION`, whose
 *    `matched` is empty. On the client this is hydration: the browser has
 *    already put focus where it belongs (the document start, or the element a
 *    URL fragment names), and a screen reader has already read the title it was
 *    served. Announcing here would repeat it; focusing here would break
 *    `#fragment` links on first load and steal focus from a page that autofocuses
 *    a field. Detected by `matched` rather than by a `hasNavigatedBefore` flag,
 *    because a flag is only correct if these hooks were registered before the
 *    first navigation ran, and Nuxt resolves that one during plugin setup.
 *
 *  - **A hash-only change.** `/docs#install` → `/docs#usage` is in-page
 *    navigation: the browser moves to the fragment and, in every current engine,
 *    focus with it. Moving focus to the top of the page instead is the one
 *    outcome the user did not ask for.
 *
 *  - **A query-only change.** `?page=2`, `?sort=name`, `?q=…` are almost always
 *    written by a control the user is still operating — a filter box, a sort
 *    header, a pager. Pulling focus out of that control on every keystroke is
 *    worse than doing nothing, and the state it changed is a status message the
 *    component that owns it should announce, not a new page.
 *
 * Which is why the comparison is on `path` alone. `fullPath` would make every
 * query change a navigation; comparing matched records would miss `/a` → `/b`
 * when both resolve to the same component.
 */
export function isPageNavigation(to: NavigationTarget, from: NavigationTarget): boolean {
  if (from.matched.length === 0) return false
  return to.path !== from.path
}

/**
 * Just enough of an element to tell whether it is still in the document.
 *
 * Structural types rather than `Element` and `HTMLElement` so the unit tests can
 * run in the `node` environment this project's Vitest config uses — there is no
 * DOM there to build an element in, and none of the logic below needs one. The
 * same reason `plugins/web-vitals.client.ts` narrows `navigator.connection`
 * structurally. Both are satisfied by the real thing without a cast:
 * `document.activeElement` is an `Element`, which has `isConnected`, and
 * `document.getElementById` returns an `HTMLElement`, which has `focus`.
 *
 * They are two types rather than one because the element that *has* focus and
 * the element focus is *moved to* are checked for different things, and keeping
 * them apart is what makes `document.activeElement` — an `Element`, which has no
 * `focus` method — usable here directly.
 */
export interface MountedElement {
  readonly isConnected: boolean
}

/** Just enough of an element to move focus to it. */
export interface FocusTarget {
  focus(options?: { preventScroll?: boolean }): void
}

/**
 * Whether something took focus deliberately while the navigation was in flight,
 * in which case the focus reset must stand down.
 *
 * The case this protects is a page that focuses its own first field on mount — a
 * search page, a login form, a composer. That page's choice is more specific
 * than this one, and it is also the *later* of the two in every ordering: Vue
 * flushes the navigation's render before `nextTick` resolves when the page is
 * synchronous, and after it when the page suspends on data. So either the reset
 * sees the page's element already focused and declines (first ordering), or it
 * runs first and the page's own `onMounted` overwrites it (second). Both land on
 * the page's choice, which is why the reset does not have to know which happened.
 *
 * `before` is what had focus when the navigation started, and comparing against
 * it is what makes the common case work. After a link click the clicked link is
 * still the active element; if that link survives the navigation (a persistent
 * nav, a card grid the route re-renders in place) then nothing has claimed focus
 * and the reset must proceed — even though `after` is a perfectly ordinary
 * focused element.
 *
 * `null` means "nothing meaningful": no active element, or `<body>` /
 * `<html>`, which is where browsers park focus when the element that had it is
 * removed from the document. Normalising those to `null` is the caller's job;
 * see `focusedElement` in `useRouteChangeA11y`.
 */
export function navigationClaimedFocus(
  before: MountedElement | null,
  after: MountedElement | null,
): boolean {
  if (after === null) return false
  // Focus moved to an element that has since been unmounted — the browser has
  // not reassigned it yet, but nothing is holding it on purpose.
  if (!after.isConnected) return false
  return after !== before
}

/**
 * A route's own title, or `null` when it declares none.
 *
 * `definePageMeta({ title })` is route metadata that Nuxt itself does nothing
 * with — `app.vue` is what puts it in the document, and this is what reads it.
 * One function for both because the document title and the announcement have to
 * agree: a page announced as something other than what its `<title>` says is
 * worse than one announced as nothing.
 *
 * `tests/unit/lint/page-titles.test.ts` is what guarantees the `null` branch is
 * unreachable from `pages/` — and, more importantly for the announcement, that
 * no two pages return the same string.
 */
export function pageTitle(meta: Readonly<Record<string, unknown>>): string | null {
  const title = meta['title']
  if (typeof title !== 'string') return null
  const trimmed = title.trim()
  return trimmed === '' ? null : trimmed
}
