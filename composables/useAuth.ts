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

  async function logout(): Promise<void> {
    await clear()
    await navigateTo('/login')
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
