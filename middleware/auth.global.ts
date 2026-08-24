// Pages a logged-out visitor may see. The route-rules demo pages are public on
// purpose: the prerendered one (`/route-rules/static`) is rendered at build time
// with no request session, so if it were gated it would prerender a login
// redirect instead of the page (see docs/nitro-route-rules.md).
const PUBLIC_PATHS = new Set(['/login', '/register', '/route-rules', '/route-rules/static'])

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
