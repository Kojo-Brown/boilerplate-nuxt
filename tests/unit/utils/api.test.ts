import { describe, it, expect, vi, beforeEach } from 'vitest'

// Stub Nuxt auto-imports before the module under test is imported
const mockNavigateTo = vi.fn()
const mockFetchCreate = vi.fn()

vi.stubGlobal('navigateTo', mockNavigateTo)
vi.stubGlobal('$fetch', { create: mockFetchCreate })

// Stable globalThis.crypto stub for UUID generation
if (typeof globalThis.crypto === 'undefined') {
  vi.stubGlobal('crypto', {
    randomUUID: () => 'test-uuid-1234-5678-abcd-ef0123456789',
  })
}

import { createApiClient } from '../../../utils/api'

describe('createApiClient', () => {
  type CapturedOptions = {
    baseURL?: string
    onRequest?: (ctx: { options: Record<string, unknown> }) => void
    onResponse?: (ctx: { request: unknown; response: { status: number }; options: Record<string, unknown> }) => void
    onResponseError?: (ctx: { response: { status: number } }) => Promise<void>
    onRequestError?: (ctx: { request: unknown; error: unknown }) => void
    [key: string]: unknown
  }

  let capturedOptions: CapturedOptions

  beforeEach(() => {
    vi.clearAllMocks()
    capturedOptions = {}
    mockFetchCreate.mockImplementation((opts: CapturedOptions) => {
      capturedOptions = opts
      return vi.fn()
    })
  })

  it('calls $fetch.create with baseURL /api', () => {
    createApiClient()
    expect(mockFetchCreate).toHaveBeenCalledOnce()
    expect(capturedOptions['baseURL']).toBe('/api')
  })

  it('merges extra base options alongside interceptors', () => {
    createApiClient({ timeout: 5000 })
    expect(capturedOptions['baseURL']).toBe('/api')
    expect(capturedOptions['timeout']).toBe(5000)
  })

  it('returns the fetch instance from $fetch.create', () => {
    const fakeClient = vi.fn()
    mockFetchCreate.mockReturnValueOnce(fakeClient)
    const client = createApiClient()
    expect(client).toBe(fakeClient)
  })

  describe('onRequest interceptor', () => {
    it('injects x-correlation-id header', () => {
      createApiClient()
      const options: Record<string, unknown> = {}
      capturedOptions.onRequest?.({ options })
      expect((options['headers'] as Headers).get('x-correlation-id')).toBeTruthy()
    })

    it('injects x-client-timestamp header as a numeric string', () => {
      createApiClient()
      const options: Record<string, unknown> = {}
      capturedOptions.onRequest?.({ options })
      const ts = (options['headers'] as Headers).get('x-client-timestamp')
      expect(ts).not.toBeNull()
      expect(Number(ts)).toBeGreaterThan(0)
    })

    it('preserves existing headers already set on the request', () => {
      createApiClient()
      const existing = new Headers({ authorization: 'Bearer token123' })
      const options: Record<string, unknown> = { headers: existing }
      capturedOptions.onRequest?.({ options })
      const headers = options['headers'] as Headers
      expect(headers.get('authorization')).toBe('Bearer token123')
      expect(headers.get('x-correlation-id')).toBeTruthy()
    })

    it('stores _meta with correlationId and startTime on the options object', () => {
      createApiClient()
      const options: Record<string, unknown> = {}
      capturedOptions.onRequest?.({ options })
      const meta = options['_meta'] as { correlationId: string; startTime: number }
      expect(typeof meta.correlationId).toBe('string')
      expect(meta.correlationId.length).toBeGreaterThan(0)
      expect(typeof meta.startTime).toBe('number')
      expect(meta.startTime).toBeGreaterThan(0)
    })
  })

  describe('onResponseError interceptor', () => {
    it('calls navigateTo(/login) for a 401 in a browser context', async () => {
      const originalWindow = globalThis.window
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(globalThis as any).window = {}

      createApiClient()
      await capturedOptions.onResponseError?.({ response: { status: 401 } })
      expect(mockNavigateTo).toHaveBeenCalledWith('/login')

      // @ts-expect-error restore
      globalThis.window = originalWindow
    })

    it('does not call navigateTo for non-401 status codes', async () => {
      createApiClient()
      await capturedOptions.onResponseError?.({ response: { status: 403 } })
      await capturedOptions.onResponseError?.({ response: { status: 500 } })
      await capturedOptions.onResponseError?.({ response: { status: 422 } })
      expect(mockNavigateTo).not.toHaveBeenCalled()
    })

    it('does not call navigateTo on 401 when window is undefined (SSR)', async () => {
      createApiClient()
      // window is undefined in the node test environment by default
      await capturedOptions.onResponseError?.({ response: { status: 401 } })
      expect(mockNavigateTo).not.toHaveBeenCalled()
    })
  })
})
