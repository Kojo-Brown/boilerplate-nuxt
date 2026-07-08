import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ref, computed } from 'vue'

// Nuxt auto-imports are unavailable in the node test environment.
// Stub them on globalThis before each test so the composable can resolve them.

const mockClear = vi.fn()
const mockRefreshSession = vi.fn()
const mockNavigateTo = vi.fn()
const mockFetch = vi.fn()

function makeMockSession(loggedIn = false) {
  const user = ref(loggedIn ? { id: '1', email: 'a@b.com', name: 'Test', provider: 'credentials' as const } : null)
  return {
    user,
    loggedIn: computed(() => user.value !== null),
    fetch: mockRefreshSession,
    clear: mockClear,
  }
}

vi.stubGlobal('useUserSession', () => makeMockSession())
vi.stubGlobal('navigateTo', mockNavigateTo)
vi.stubGlobal('$fetch', mockFetch)

// Static import is safe: the composable body only runs when useAuth() is called,
// so the global stubs above are in place before any reference is resolved.
import { useAuth } from '../../../composables/useAuth'

describe('useAuth', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('useUserSession', () => makeMockSession())
  })

  it('returns user, loggedIn, isLoading (false), and error (null) on init', () => {
    const auth = useAuth()
    expect(auth.user).toBeDefined()
    expect(auth.loggedIn).toBeDefined()
    expect(auth.isLoading.value).toBe(false)
    expect(auth.error.value).toBeNull()
  })

  it('exposes login, loginWithGitHub, logout, and refresh methods', () => {
    const auth = useAuth()
    expect(typeof auth.login).toBe('function')
    expect(typeof auth.loginWithGitHub).toBe('function')
    expect(typeof auth.logout).toBe('function')
    expect(typeof auth.refresh).toBe('function')
  })

  describe('login()', () => {
    it('posts credentials, refreshes session, and navigates to / on success', async () => {
      mockFetch.mockResolvedValueOnce({ ok: true })
      mockRefreshSession.mockResolvedValueOnce(undefined)
      mockNavigateTo.mockResolvedValueOnce(undefined)

      const auth = useAuth()
      const result = await auth.login('test@example.com', 'password123')

      expect(mockFetch).toHaveBeenCalledWith('/api/auth/login', {
        method: 'POST',
        body: { email: 'test@example.com', password: 'password123' },
      })
      expect(mockRefreshSession).toHaveBeenCalledOnce()
      expect(mockNavigateTo).toHaveBeenCalledWith('/')
      expect(result).toBe(true)
    })

    it('sets error message from response and returns false on failure', async () => {
      mockFetch.mockRejectedValueOnce({ data: { message: 'Invalid email or password' } })

      const auth = useAuth()
      const result = await auth.login('bad@example.com', 'wrongpass')

      expect(result).toBe(false)
      expect(auth.error.value).toBe('Invalid email or password')
      expect(mockNavigateTo).not.toHaveBeenCalled()
    })

    it('falls back to generic error message when response has no message', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network error'))

      const auth = useAuth()
      await auth.login('test@example.com', 'password')

      expect(auth.error.value).toBe('Login failed. Please try again.')
    })

    it('resets isLoading to false after success', async () => {
      mockFetch.mockResolvedValueOnce({ ok: true })
      mockRefreshSession.mockResolvedValueOnce(undefined)
      mockNavigateTo.mockResolvedValueOnce(undefined)

      const auth = useAuth()
      await auth.login('test@example.com', 'password123')

      expect(auth.isLoading.value).toBe(false)
    })

    it('resets isLoading to false after failure', async () => {
      mockFetch.mockRejectedValueOnce({ data: { message: 'Unauthorized' } })

      const auth = useAuth()
      await auth.login('test@example.com', 'wrongpass')

      expect(auth.isLoading.value).toBe(false)
    })

    it('clears a previous error before attempting a new login', async () => {
      const auth = useAuth()

      mockFetch.mockRejectedValueOnce({ data: { message: 'First error' } })
      await auth.login('a@b.com', 'pass1')
      expect(auth.error.value).toBe('First error')

      mockFetch.mockResolvedValueOnce({ ok: true })
      mockRefreshSession.mockResolvedValueOnce(undefined)
      mockNavigateTo.mockResolvedValueOnce(undefined)
      await auth.login('a@b.com', 'pass2')
      expect(auth.error.value).toBeNull()
    })
  })

  describe('loginWithGitHub()', () => {
    it('navigates to /auth/github as an external route', () => {
      const auth = useAuth()
      auth.loginWithGitHub()
      expect(mockNavigateTo).toHaveBeenCalledWith('/auth/github', { external: true })
    })
  })

  describe('logout()', () => {
    it('clears the session and navigates to /login', async () => {
      mockClear.mockResolvedValueOnce(undefined)
      mockNavigateTo.mockResolvedValueOnce(undefined)

      const auth = useAuth()
      await auth.logout()

      expect(mockClear).toHaveBeenCalledOnce()
      expect(mockNavigateTo).toHaveBeenCalledWith('/login')
    })
  })

  describe('refresh()', () => {
    it('calls the underlying session refresh', async () => {
      mockRefreshSession.mockResolvedValueOnce(undefined)

      const auth = useAuth()
      await auth.refresh()

      expect(mockRefreshSession).toHaveBeenCalledOnce()
    })
  })
})
