const PUBLIC_PATHS = new Set(['/login', '/register'])

export default defineNuxtRouteMiddleware((to) => {
  const { loggedIn } = useUserSession()

  if (!loggedIn.value && !PUBLIC_PATHS.has(to.path)) {
    return navigateTo('/login', { replace: true })
  }

  if (loggedIn.value && PUBLIC_PATHS.has(to.path)) {
    return navigateTo('/', { replace: true })
  }
})
