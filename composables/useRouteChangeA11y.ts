import { getCurrentScope, nextTick, onScopeDispose } from 'vue'

import {
  MAIN_CONTENT_ID,
  isPageNavigation,
  navigationClaimedFocus,
  pageTitle,
  type FocusTarget,
  type MountedElement,
  type NavigationTarget,
} from '~/utils/routeNavigation'

/**
 * Gives a client-side navigation the two things a full page load does for free:
 * focus at the start of the new page, and an announcement that it arrived.
 *
 * Called once, from `app.vue`, which is the only component that outlives every
 * navigation. Everything it decides is in `utils/routeNavigation.ts`; what is
 * left here is the part that cannot be pure — the router subscription, the two
 * reads of `document.activeElement`, and the `focus()` call.
 *
 * ## Why a composable in `app.vue` and not a plugin
 *
 * A plugin is the usual home for a once-per-app subscription, and
 * `docs/composable-design-rules.md` names `plugins/` as the escape hatch for
 * exactly this. It is the wrong one here for two reasons. The announcement text
 * is a translated string, so composing it wants `useI18n()` — which resolves
 * against a component's setup context, not a plugin's, and would otherwise mean
 * ordering this plugin after `@nuxtjs/i18n`'s. And the focus target is an element
 * `app.vue` renders, so the subscription's lifetime is already that component's.
 * Taking the message as an injected `describe` keeps this module free of i18n
 * either way: *when* to announce is a decision about navigation, *what* to say is
 * a decision about language.
 */

/**
 * The ambient values `useRouteChangeA11y` reads. Injected rather than reached
 * for, so the unit tests can drive a navigation without a router, a DOM or a
 * render loop — see `docs/composable-design-rules.md`.
 */
export interface RouteChangeA11yDeps {
  /** The router whose navigations are observed. Default: `useRouter()`. */
  router: RouterLike
  /**
   * What currently holds focus, or `null` when nothing meaningful does. Default:
   * {@link focusedElement}.
   */
  activeElement: () => MountedElement | null
  /**
   * The element page content is rendered into. Default: the element with
   * `MAIN_CONTENT_ID`, which `app.vue` renders.
   */
  contentElement: () => FocusTarget | null
  /**
   * Resolves once the renderer has applied the navigation. Default: `nextTick`.
   */
  rendered: () => Promise<void>
  /**
   * What to announce for a route, or `''` to stay silent. Default: the route's
   * own `definePageMeta({ title })`, unwrapped. `app.vue` passes a translated
   * sentence built around it.
   */
  describe: (to: NavigationTarget) => string
  /** Where the announcement is published. Default: `useRouteAnnouncement()`. */
  announce: (text: string) => void | Promise<void>
}

/**
 * The part of vue-router's `Router` this subscribes to.
 *
 * Narrowed to the two registration methods, which both return their own
 * unregister function, so a test's fake is two lines rather than a whole router.
 */
export interface RouterLike {
  beforeEach(hook: () => void): () => void
  afterEach(hook: (to: NavigationTarget, from: NavigationTarget) => void): () => void
}

export function useRouteChangeA11y(deps: Partial<RouteChangeA11yDeps> = {}): void {
  // Nothing here has a server-side meaning: there is one navigation during SSR,
  // it is the first one, and `isPageNavigation` would reject it anyway. Returning
  // early says so, and keeps the `document` reads below unreachable on a runtime
  // that has no document.
  if (import.meta.server) return

  const {
    router = useRouter(),
    activeElement = focusedElement,
    contentElement = mainContentElement,
    rendered = nextTick,
    describe = (to) => pageTitle(to.meta) ?? '',
    announce = useRouteAnnouncement().announce,
  } = deps

  /**
   * What held focus when the current navigation began.
   *
   * Captured in `beforeEach` because by the time the navigation has resolved the
   * answer is gone: the clicked link may have been unmounted, and whatever the
   * new page focused is already in its place. `navigationClaimedFocus` needs both
   * ends to tell those two apart.
   *
   * A `let` inside the composable, not at module scope — one per call, which is
   * one per Nuxt app. See `docs/composable-design-rules.md`.
   */
  let focusedAtNavigationStart: MountedElement | null = null

  const unsubscribe = [
    router.beforeEach(() => {
      focusedAtNavigationStart = activeElement()
    }),

    router.afterEach((to, from) => {
      if (!isPageNavigation(to, from)) return
      void handleNavigation(to)
    }),
  ]

  async function handleNavigation(to: NavigationTarget): Promise<void> {
    // Announced first, and without waiting for the render. The text comes from
    // route metadata rather than from the document, so there is nothing to wait
    // for — and on a page that suspends on data, "you are now on the orders page"
    // is worth hearing while it loads rather than after.
    const text = describe(to)
    if (text !== '') void announce(text)

    await rendered()

    // The page may have focused something of its own by now, in which case its
    // choice wins; see `navigationClaimedFocus` for why this holds whichever
    // order the two happened in.
    if (navigationClaimedFocus(focusedAtNavigationStart, activeElement())) return

    // `preventScroll`, because scrolling is the router's job and it has already
    // done it: Nuxt's `scrollBehavior` goes to the top on a push and restores the
    // saved position on a back or forward. Focusing without this flag scrolls the
    // element into view, which on a back navigation undoes the restore and drops
    // the user at the top of a page they were half way down.
    contentElement()?.focus({ preventScroll: true })
  }

  // `app.vue` never unmounts, so this never runs in production. It is here
  // because a subscription whose teardown is "this component is immortal" is one
  // refactor away from a leak, and because `@nuxt/test-utils` mounts and unmounts
  // the app repeatedly in one process.
  if (getCurrentScope()) {
    onScopeDispose(() => {
      for (const stop of unsubscribe) stop()
    })
  }
}

/**
 * `document.activeElement`, with the places a browser parks focus normalised to
 * `null`.
 *
 * `<body>` is where focus lands when the element that had it is removed from the
 * document, and `<html>` is where some engines put it when nothing is focused at
 * all. Neither is a deliberate focus position, and treating either as one would
 * make the reset stand down exactly when it is needed.
 */
function focusedElement(): MountedElement | null {
  const active = document.activeElement
  if (active === null || active === document.body || active === document.documentElement) {
    return null
  }
  return active
}

function mainContentElement(): FocusTarget | null {
  return document.getElementById(MAIN_CONTENT_ID)
}
