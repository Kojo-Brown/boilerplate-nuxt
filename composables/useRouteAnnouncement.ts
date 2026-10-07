import { nextTick, readonly } from 'vue'

/**
 * The text the route announcer's live region is currently holding.
 *
 * Split from `useRouteChangeA11y` — which decides *when* to announce — because
 * two callers need the state and only one of them does the deciding:
 * `components/AppRouteAnnouncer.vue` renders `message`, and the router hooks call
 * `announce`. Were this one composable, the component would register a second set
 * of router hooks just by reading the message.
 *
 * ## Why this is not `<NuxtRouteAnnouncer />`
 *
 * Nuxt ships a route announcer and this app used it. It announces
 * `document.title`, re-read on unhead's `dom:rendered` hook, and two properties
 * of that made it the wrong mechanism here:
 *
 *  - **It is driven by the document title, not by navigation.** `dom:rendered`
 *    fires whenever anything in the head changes, and not at all when a
 *    navigation leaves the head alone. So it cannot tell a page change from a
 *    `useSeoMeta` update on the page you are already on, and it has no way to
 *    know that a navigation was hash-only and should be left alone.
 *  - **It announces the whole document title.** Here that is
 *    `<page> · Nuxt 4 Boilerplate` (see `app.vue`), so every announcement would
 *    repeat the product name. A route announcement wants the part that changed.
 *
 * It is also how this app's announcements were silent on more than half its
 * pages, because the title it read was identical on all of them — see
 * `tests/unit/lint/page-titles.test.ts` for the gate that now stops that
 * recurring.
 */

/**
 * The `useState` key the message is filed under. Namespaced, because the payload
 * is one flat object shared with every other `useState` call and with Nuxt's own
 * internals.
 */
const ROUTE_ANNOUNCEMENT_KEY = 'app:route-announcement'

/**
 * The ambient values `useRouteAnnouncement` reads. Injected rather than reached
 * for, so a test can observe the intermediate state of a repeated announcement
 * without a real render loop — see `docs/composable-design-rules.md`.
 */
export interface RouteAnnouncementDeps {
  /**
   * Resolves once the renderer has applied the pending change. Default:
   * `nextTick`. Only used on the repeat path below, where the point is that one
   * render happens between the two writes.
   */
  flush: () => Promise<void>
}

/**
 * The route announcer's message, and the one way to set it.
 *
 * State is in `useState` rather than a module-scope `ref` so the server builds
 * one per request: a module-scope ref would be one string shared by every
 * visitor a process serves, and a live region is exactly the kind of thing that
 * would then be rendered into the wrong person's page. It starts empty and is
 * serialized empty, which is also what keeps the initial load quiet — a live
 * region announces changes made after it is registered, and the first render is
 * what registers it.
 *
 * @param deps Overrides for {@link RouteAnnouncementDeps}; every field defaults
 *   to the real thing, so application code calls `useRouteAnnouncement()`.
 */
export function useRouteAnnouncement(deps: Partial<RouteAnnouncementDeps> = {}) {
  const { flush = nextTick } = deps

  const message = useState<string>(ROUTE_ANNOUNCEMENT_KEY, () => '')

  /**
   * Puts `text` in the live region, in a way that is guaranteed to be announced.
   *
   * A live region fires on a *change* to its contents. Assigning the string it
   * already holds changes nothing — Vue does not re-render, the text node is not
   * touched, and the screen reader stays silent. That is not hypothetical: it is
   * what "two pages with the same `<title>`" looked like under the Nuxt
   * announcer this replaces, and a dynamic route (`/orders/[id]`) whose pages
   * share a title would reproduce it here.
   *
   * So a repeat is written in two steps, with a render in between: empty, then
   * the text. The common case — consecutive pages with different names, which
   * `tests/unit/lint/page-titles.test.ts` makes the only possibility for the
   * static routes in `pages/` — takes the single-write path and never clears, so
   * nothing flickers through an empty region for a frame.
   */
  async function announce(text: string): Promise<void> {
    if (text === message.value) {
      message.value = ''
      await flush()
    }
    message.value = text
  }

  return { message: readonly(message), announce }
}
