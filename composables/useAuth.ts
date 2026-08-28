import { ref, readonly } from 'vue'

export interface AuthUser {
  id: string
  email: string
  name: string
  provider: 'credentials' | 'github'
  login?: string
  avatarUrl?: string
}

export function useAuth() {
  const { user, loggedIn, fetch: refreshSession, clear } = useUserSession()

  const isLoading = ref(false)
  const error = ref<string | null>(null)

  async function login(email: string, password: string): Promise<boolean> {
    isLoading.value = true
    error.value = null
    try {
      await $fetch('/api/auth/login', {
        method: 'POST',
        body: { email, password },
      })
      await refreshSession()
      await navigateTo('/')
      return true
    } catch (err: unknown) {
      const typedErr = err as { data?: { message?: string } }
      error.value = typedErr.data?.message ?? 'Login failed. Please try again.'
      return false
    } finally {
      isLoading.value = false
    }
  }

  function loginWithGitHub(): void {
    navigateTo('/auth/github', { external: true })
  }

  /**
   * Signs out. `scope: 'all'` revokes every session this user has, on every
   * device, instead of only this one.
   *
   * `clear()` alone — what this used to do — drops the cookie in *this* browser
   * and nothing more; a sealed session stays valid on the server until it
   * expires. `/api/auth/logout` revokes it in the session registry first, which
   * is what actually ends it. See `server/utils/session-store.ts`.
   *
   * A failed revocation still signs the user out locally (the route clears the
   * cookie before it reports the failure), so the navigation happens either way
   * and the error surfaces on `error` for the caller to show.
   */
  async function logout(scope: 'current' | 'all' = 'current'): Promise<void> {
    error.value = null
    try {
      await $fetch('/api/auth/logout', { method: 'POST', body: { scope } })
    } catch (err: unknown) {
      const typedErr = err as { data?: { message?: string } }
      error.value = typedErr.data?.message ?? 'Sign-out completed on this device only.'
    } finally {
      await clear()
      await navigateTo('/login')
    }
  }

  async function refresh(): Promise<void> {
    await refreshSession()
  }

  return {
    user: readonly(user),
    loggedIn: readonly(loggedIn),
    isLoading: readonly(isLoading),
    error: readonly(error),
    login,
    loginWithGitHub,
    logout,
    refresh,
  }
}
