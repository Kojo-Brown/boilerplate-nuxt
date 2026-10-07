import { describe, expect, it, vi } from 'vitest'

import { useRouteChangeA11y, type RouterLike } from '~/composables/useRouteChangeA11y'
import type { FocusTarget, MountedElement, NavigationTarget } from '~/utils/routeNavigation'

/**
 * The wiring: a navigation arrives, and focus and the live region are brought up
 * to date.
 *
 * Everything the composable needs from the outside world is injected, so this runs
 * in the `node` environment the rest of `pnpm test` uses — no router, no document,
 * no render loop. What is being asserted is the sequencing, which is the part a
 * browser test can see the result of but not the reason for.
 */

function route(path: string, meta: Record<string, unknown> = {}): NavigationTarget {
  return { path, matched: [{}], meta }
}

const START_LOCATION: NavigationTarget = { path: '/', matched: [], meta: {} }

/** A router whose two hooks can be fired by hand, and whose teardown is observable. */
function fakeRouter() {
  const before: Array<() => void> = []
  const after: Array<(to: NavigationTarget, from: NavigationTarget) => void> = []
  const unsubscribed: string[] = []

  const router: RouterLike = {
    beforeEach(hook) {
      before.push(hook)
      return () => unsubscribed.push('beforeEach')
    },
    afterEach(hook) {
      after.push(hook)
      return () => unsubscribed.push('afterEach')
    },
  }

  return {
    router,
    unsubscribed,
    /** One navigation, start to finish, awaited to the end of the composable's work. */
    async navigate(to: NavigationTarget, from: NavigationTarget) {
      for (const hook of before) hook()
      for (const hook of after) hook(to, from)
      // The composable's `afterEach` kicks off an async handler it does not await.
      // Two microtask turns: one for the injected `rendered`, one for the
      // continuation after it.
      await Promise.resolve()
      await Promise.resolve()
    },
  }
}

/**
 * The composable wired to fakes, with the observable effects collected.
 *
 * `focus` starts as the element a link click would leave focused, which is the
 * case that has to reset: the link is still in the document and still has focus,
 * and nothing claimed it.
 */
function harness(
  overrides: {
    content?: FocusTarget | null
    onRendered?: () => void
  } = {},
) {
  const clickedLink: MountedElement = { isConnected: true }
  const announced: string[] = []
  const focused: Array<{ preventScroll?: boolean | undefined }> = []

  const state = { focus: clickedLink as MountedElement | null }

  const content: FocusTarget | null =
    overrides.content === undefined
      ? {
          focus(options) {
            focused.push(options ?? {})
          },
        }
      : overrides.content

  const router = fakeRouter()

  useRouteChangeA11y({
    router: router.router,
    activeElement: () => state.focus,
    contentElement: () => content,
    rendered: () => {
      overrides.onRendered?.()
      return Promise.resolve()
    },
    describe: (to) =>
      typeof to.meta['title'] === 'string' ? `Navigated to ${to.meta['title']}` : '',
    announce: (text) => {
      announced.push(text)
    },
  })

  return { ...router, announced, focused, state, clickedLink }
}

describe('useRouteChangeA11y', () => {
  it('announces the new page and moves focus into the content', async () => {
    const h = harness()

    await h.navigate(route('/streaming', { title: 'Streaming SSR' }), route('/'))

    expect(h.announced).toEqual(['Navigated to Streaming SSR'])
    expect(h.focused).toHaveLength(1)
  })

  it('moves focus without scrolling', async () => {
    // Scrolling belongs to the router, which has already done it: top of the page
    // on a push, the saved position on a back or forward. Focusing without this
    // flag scrolls the element into view and undoes the restore, dropping the user
    // at the top of a page they were half way down.
    const h = harness()

    await h.navigate(route('/upload', { title: 'File Upload' }), route('/'))

    expect(h.focused).toEqual([{ preventScroll: true }])
  })

  it('does nothing on the first navigation', async () => {
    // Hydration: the browser has already placed focus and the screen reader has
    // already read the served title.
    const h = harness()

    await h.navigate(route('/upload', { title: 'File Upload' }), START_LOCATION)

    expect(h.announced).toEqual([])
    expect(h.focused).toEqual([])
  })

  it('does nothing when the path is unchanged', async () => {
    // A hash or query change: the skip link's own fragment, a filter, a pager.
    const h = harness()

    await h.navigate(route('/data-patterns', { title: 'X' }), route('/data-patterns'))

    expect(h.announced).toEqual([])
    expect(h.focused).toEqual([])
  })

  it('leaves focus alone when the new page claimed it', async () => {
    // A page that focuses its own first field on mount. Its choice is the more
    // specific one, and the announcement still happens — the user is told where
    // they are without being moved.
    const h = harness({
      onRendered: () => {
        h.state.focus = { isConnected: true }
      },
    })

    await h.navigate(route('/login', { title: 'Sign in' }), route('/'))

    expect(h.announced).toEqual(['Navigated to Sign in'])
    expect(h.focused).toEqual([])
  })

  it('resets focus when the element that had it was unmounted', async () => {
    // The clicked link is gone and the browser has not reassigned focus yet.
    // Nothing is holding it on purpose, so the reset proceeds.
    const h = harness({
      onRendered: () => {
        h.state.focus = { isConnected: false }
      },
    })

    await h.navigate(route('/islands', { title: 'Server Islands' }), route('/'))

    expect(h.focused).toHaveLength(1)
  })

  it('announces before waiting for the render', async () => {
    // The text comes from route metadata, not from the document, so there is
    // nothing to wait for — and on a page that suspends on data, "you are now on
    // the upload page" is worth hearing while it loads rather than after.
    const announcedBeforeRender: string[][] = []
    const h = harness({
      onRendered: () => announcedBeforeRender.push([...h.announced]),
    })

    await h.navigate(route('/upload', { title: 'File Upload' }), route('/'))

    expect(announcedBeforeRender).toEqual([['Navigated to File Upload']])
  })

  it('stays silent for a route that names itself nothing, but still moves focus', async () => {
    // `describe` returning `''` means "say nothing". Focus is a separate question:
    // a page with no title is still a different page to tab through.
    const h = harness()

    await h.navigate(route('/nameless'), route('/'))

    expect(h.announced).toEqual([])
    expect(h.focused).toHaveLength(1)
  })

  it('does not throw when there is no content element to focus', async () => {
    // Defensive rather than expected: `app.vue` always renders it. A thrown error
    // inside an unawaited router hook would surface as an unhandled rejection with
    // no navigation in the stack.
    const h = harness({ content: null })

    await expect(
      h.navigate(route('/upload', { title: 'File Upload' }), route('/')),
    ).resolves.toBeUndefined()
    expect(h.announced).toEqual(['Navigated to File Upload'])
  })

  it('unsubscribes from both hooks when its scope is disposed', async () => {
    const { effectScope } = await import('vue')
    const router = fakeRouter()
    const scope = effectScope()

    scope.run(() => {
      useRouteChangeA11y({
        router: router.router,
        activeElement: () => null,
        contentElement: () => null,
        rendered: () => Promise.resolve(),
        describe: () => '',
        announce: () => {},
      })
    })
    scope.stop()

    expect(router.unsubscribed.sort()).toEqual(['afterEach', 'beforeEach'])
  })

  it('reads the focused element at the start of the navigation, not after it', async () => {
    // The comparison only means anything if `before` is captured while the old
    // page is still mounted. Captured in `afterEach` instead, it would equal
    // `after` on every navigation and the reset would never stand down.
    const seen: Array<MountedElement | null> = []
    const router = fakeRouter()
    const first: MountedElement = { isConnected: true }
    const second: MountedElement = { isConnected: true }
    const state = { focus: first as MountedElement | null }

    useRouteChangeA11y({
      router: router.router,
      activeElement: () => {
        seen.push(state.focus)
        return state.focus
      },
      contentElement: () => null,
      rendered: () => {
        state.focus = second
        return Promise.resolve()
      },
      describe: () => '',
      announce: vi.fn(),
    })

    await router.navigate(route('/b'), route('/a'))

    expect(seen).toEqual([first, second])
  })
})
