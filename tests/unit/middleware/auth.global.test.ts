import { describe, it, expect, vi, beforeEach } from 'vitest'
import { computed, ref } from 'vue'

// defineNuxtRouteMiddleware is an identity wrapper — stub it before importing
// so the default export resolves to the raw handler function.
const mockNavigateTo = vi.fn()

vi.stubGlobal('defineNuxtRouteMiddleware', (fn: unknown) => fn)
vi.stubGlobal('navigateTo', mockNavigateTo)

type MockUser = { id: string; email: string; name: string; provider: 'credentials' | 'github' }

function makeSession(authenticated: boolean) {
  const user = ref<MockUser | null>(
    authenticated
      ? { id: '1', email: 'user@example.com', name: 'Test User', provider: 'credentials' }
      : null,
  )
  return {
    user,
    loggedIn: computed(() => user.value !== null),
    fetch: vi.fn(),
    clear: vi.fn(),
  }
}

// Import AFTER stubs so defineNuxtRouteMiddleware is already globalThis when
// the module is evaluated and calls defineNuxtRouteMiddleware(handler).
import authMiddleware from '../../../middleware/auth.global'

type RouteMiddlewareFn = (
  to: { path: string },
  from: { path: string },
) => ReturnType<typeof mockNavigateTo> | undefined

const handler = authMiddleware as unknown as RouteMiddlewareFn

describe('auth.global middleware', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('unauthenticated user', () => {
    beforeEach(() => {
      vi.stubGlobal('useUserSession', () => makeSession(false))
    })

    it('redirects to /login when accessing a protected route (/)', () => {
      handler({ path: '/' }, { path: '' })
      expect(mockNavigateTo).toHaveBeenCalledWith('/login', { replace: true })
    })

    it('redirects to /login when accessing any other protected path', () => {
      handler({ path: '/dashboard' }, { path: '' })
      expect(mockNavigateTo).toHaveBeenCalledWith('/login', { replace: true })
    })

    it('does not redirect when accessing /login', () => {
      handler({ path: '/login' }, { path: '' })
      expect(mockNavigateTo).not.toHaveBeenCalled()
    })

    it('does not redirect when accessing /register', () => {
      handler({ path: '/register' }, { path: '' })
      expect(mockNavigateTo).not.toHaveBeenCalled()
    })
  })

  describe('authenticated user', () => {
    beforeEach(() => {
      vi.stubGlobal('useUserSession', () => makeSession(true))
    })

    it('redirects to / when accessing /login', () => {
      handler({ path: '/login' }, { path: '' })
      expect(mockNavigateTo).toHaveBeenCalledWith('/', { replace: true })
    })

    it('redirects to / when accessing /register', () => {
      handler({ path: '/register' }, { path: '' })
      expect(mockNavigateTo).toHaveBeenCalledWith('/', { replace: true })
    })

    it('does not redirect when accessing a protected route (/)', () => {
      handler({ path: '/' }, { path: '' })
      expect(mockNavigateTo).not.toHaveBeenCalled()
    })

    it('does not redirect when accessing any other protected path', () => {
      handler({ path: '/settings' }, { path: '' })
      expect(mockNavigateTo).not.toHaveBeenCalled()
    })
  })
})
