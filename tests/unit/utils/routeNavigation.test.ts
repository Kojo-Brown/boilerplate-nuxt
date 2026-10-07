import { describe, expect, it } from 'vitest'

import {
  MAIN_CONTENT_ID,
  isPageNavigation,
  navigationClaimedFocus,
  pageTitle,
  type MountedElement,
  type NavigationTarget,
} from '~/utils/routeNavigation'

/**
 * The decisions behind focus management and route announcements, case by case.
 *
 * Each `it` below names a navigation that a naive "the route changed, so reset
 * focus" implementation gets wrong, which is the whole reason these are functions
 * with names rather than conditions inside a router hook.
 */

/** A resolved route. `matched` is non-empty unless the test wants START_LOCATION. */
function route(path: string, meta: Record<string, unknown> = {}): NavigationTarget {
  return { path, matched: [{}], meta }
}

/** vue-router's `START_LOCATION`: the only route whose `matched` is empty. */
const START_LOCATION: NavigationTarget = { path: '/', matched: [], meta: {} }

describe('isPageNavigation', () => {
  it('is true when the path changes', () => {
    expect(isPageNavigation(route('/rendering/ssr'), route('/rendering'))).toBe(true)
  })

  it('is false for the first navigation, whatever the paths are', () => {
    // Hydration. The browser already put focus where it belongs and the screen
    // reader already read the title it was served; doing either again is a
    // regression, not a fix.
    expect(isPageNavigation(route('/upload'), START_LOCATION)).toBe(false)
  })

  it('is false when only the hash changes', () => {
    // In-page navigation: the browser moves to the fragment and takes focus with
    // it. This is also what the skip link does, and announcing the page the user
    // is already on is the bug it would cause.
    expect(isPageNavigation(route('/docs'), route('/docs'))).toBe(false)
  })

  it('is false when only the query changes', () => {
    // `?page=2`, `?sort=name`, `?q=…` are written by a control the user is still
    // operating. Pulling focus out of a filter box on every keystroke is worse
    // than doing nothing at all.
    expect(isPageNavigation(route('/data-patterns'), route('/data-patterns'))).toBe(false)
  })

  it('is true when two paths resolve to the same component', () => {
    // The comparison is on `path`, not on `matched`. A single page file serving
    // both paths is still two pages as far as the user is concerned.
    const component = {}
    const to: NavigationTarget = { path: '/orders/2', matched: [component], meta: {} }
    const from: NavigationTarget = { path: '/orders/1', matched: [component], meta: {} }

    expect(isPageNavigation(to, from)).toBe(true)
  })
})

describe('navigationClaimedFocus', () => {
  const link: MountedElement = { isConnected: true }
  const input: MountedElement = { isConnected: true }

  it('is false when focus has not moved since the navigation started', () => {
    // The common case: a clicked link that survived the navigation still holds
    // focus. Nothing claimed it, so the reset must proceed — even though there is
    // a perfectly ordinary focused element.
    expect(navigationClaimedFocus(link, link)).toBe(false)
  })

  it('is false when nothing meaningful holds focus', () => {
    // Where the browser parks focus after removing the element that had it. The
    // caller normalises `<body>` and `<html>` to null for this reason.
    expect(navigationClaimedFocus(link, null)).toBe(false)
  })

  it('is false when focus moved to an element that has since been unmounted', () => {
    // A page that focused a field and then replaced it. Nothing is holding focus
    // on purpose any more, so the reset should still run.
    expect(navigationClaimedFocus(link, { isConnected: false })).toBe(false)
  })

  it('is true when the new page focused something of its own', () => {
    // A search page, a login form, a composer: its choice is more specific than
    // "the top of the page" and wins.
    expect(navigationClaimedFocus(link, input)).toBe(true)
  })

  it('is true when something took focus during a navigation that started with none', () => {
    expect(navigationClaimedFocus(null, input)).toBe(true)
  })
})

describe('pageTitle', () => {
  it('reads a string title', () => {
    expect(pageTitle({ title: 'Streaming SSR' })).toBe('Streaming SSR')
  })

  it('trims it', () => {
    expect(pageTitle({ title: '  Streaming SSR \n' })).toBe('Streaming SSR')
  })

  it('is null when there is no title', () => {
    expect(pageTitle({})).toBeNull()
  })

  it('is null for a title that is not a string', () => {
    // `route.meta` is `Record<string, unknown>`: anything can be in there, and a
    // number would otherwise reach `<title>` and the live region as "[object …]"
    // or as a bare digit.
    expect(pageTitle({ title: 42 })).toBeNull()
    expect(pageTitle({ title: null })).toBeNull()
  })

  it('is null for a title that is only whitespace', () => {
    // Which is the same as no title: `app.vue` falls back to the product name,
    // and the announcer stays silent rather than announcing a space.
    expect(pageTitle({ title: '   ' })).toBeNull()
  })
})

describe('MAIN_CONTENT_ID', () => {
  it('is a valid fragment identifier', () => {
    // It is interpolated into an `href` by `AppSkipLink.vue`, so a character
    // needing escaping there would produce a link to nowhere.
    expect(MAIN_CONTENT_ID).toMatch(/^[a-z][\w-]*$/)
  })
})
