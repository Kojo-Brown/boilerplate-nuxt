// Pages a logged-out visitor may see. The route-rules demo pages are public on
// purpose: the prerendered one (`/route-rules/static`) is rendered at build time
// with no request session, so if it were gated it would prerender a login
// redirect instead of the page (see docs/nitro-route-rules.md).
// The islands demo is public for a second reason on top of being a demo: an
// island's response is keyed by its props alone, so it is the same bytes for
// every caller and wants to be cacheable. Gating the page that renders it would
// make each island response depend on a session — the opposite of what an island
// is for. See docs/server-islands.md.
const PUBLIC_PATHS = new Set([
  '/login',
  '/register',
  '/route-rules',
  '/route-rules/static',
  '/islands',
])

// The subset of public pages that a *logged-in* user should be bounced away
// from — landing on the login form while already authenticated is a dead end.
// The demo pages are not in here: being signed in is no reason to hide them.
const GUEST_ONLY_PATHS = new Set(['/login', '/register'])

export default defineNuxtRouteMiddleware((to) => {
  const { loggedIn } = useUserSession()

  if (!loggedIn.value && !PUBLIC_PATHS.has(to.path)) {
    return navigateTo('/login', { replace: true })
  }

  if (loggedIn.value && GUEST_ONLY_PATHS.has(to.path)) {
    return navigateTo('/', { replace: true })
  }
})
