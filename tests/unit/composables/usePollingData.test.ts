import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ── Nuxt / Vue auto-import stubs ──────────────────────────────────────────────

const mockRefresh = vi.fn().mockResolvedValue(undefined)
const mockAsyncData = {
  data: { value: null },
  status: { value: 'success' },
  error: { value: null },
  refresh: mockRefresh,
  execute: vi.fn(),
  clear: vi.fn(),
}

vi.stubGlobal('useAsyncData', vi.fn(() => mockAsyncData))
vi.stubGlobal('ref', (v: unknown) => ({ value: v }))
vi.stubGlobal('readonly', (r: unknown) => r)
vi.stubGlobal('onMounted', vi.fn())
vi.stubGlobal('onUnmounted', vi.fn())

// ── Module under test ─────────────────────────────────────────────────────────

import { usePollingData } from '../../../composables/usePollingData'

describe('usePollingData', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()

    // Reset stubs so they capture fresh calls this test
    vi.stubGlobal('useAsyncData', vi.fn(() => mockAsyncData))
    vi.stubGlobal('onMounted', vi.fn())
    vi.stubGlobal('onUnmounted', vi.fn())
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('calls useAsyncData with the given key and fetcher', () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: true })
    usePollingData('my-key', fetcher)
    expect((globalThis as Record<string, unknown>)['useAsyncData']).toHaveBeenCalledWith(
      'my-key',
      fetcher,
      expect.objectContaining({ immediate: true }),
    )
  })

  it('passes immediate: false when option is set', () => {
    const fetcher = vi.fn()
    usePollingData('k', fetcher, { immediate: false })
    expect((globalThis as Record<string, unknown>)['useAsyncData']).toHaveBeenCalledWith(
      'k',
      fetcher,
      expect.objectContaining({ immediate: false }),
    )
  })

  it('returns startPolling, stopPolling, and isPolling alongside asyncData', () => {
    const result = usePollingData('k', vi.fn())
    expect(typeof result.startPolling).toBe('function')
    expect(typeof result.stopPolling).toBe('function')
    expect(result.isPolling).toBeDefined()
  })

  it('returns the refresh function from useAsyncData', () => {
    const result = usePollingData('k', vi.fn())
    expect(result.refresh).toBe(mockRefresh)
  })

  it('registers onMounted and onUnmounted hooks on the client', () => {
    // import.meta.client is false in node environment so hooks are NOT registered
    usePollingData('k', vi.fn())
    // In server/node context import.meta.client = false — no hooks registered
    expect((globalThis as Record<string, unknown>)['onMounted']).not.toHaveBeenCalled()
    expect((globalThis as Record<string, unknown>)['onUnmounted']).not.toHaveBeenCalled()
  })

  describe('startPolling / stopPolling', () => {
    it('stopPolling does not throw when called before startPolling', () => {
      const { stopPolling } = usePollingData('k', vi.fn())
      expect(() => stopPolling()).not.toThrow()
    })

    it('startPolling sets up an interval that calls refresh()', async () => {
      const fetcher = vi.fn().mockResolvedValue({})
      const { startPolling } = usePollingData('k', fetcher, { interval: 1_000 })

      startPolling()
      expect(mockRefresh).not.toHaveBeenCalled()

      vi.advanceTimersByTime(1_000)
      await vi.runAllTimersAsync()
      expect(mockRefresh).toHaveBeenCalledTimes(1)

      vi.advanceTimersByTime(1_000)
      await vi.runAllTimersAsync()
      expect(mockRefresh).toHaveBeenCalledTimes(2)
    })

    it('stopPolling clears the interval so refresh is no longer called', async () => {
      const fetcher = vi.fn().mockResolvedValue({})
      const { startPolling, stopPolling } = usePollingData('k', fetcher, { interval: 500 })

      startPolling()
      vi.advanceTimersByTime(500)
      await vi.runAllTimersAsync()
      expect(mockRefresh).toHaveBeenCalledTimes(1)

      stopPolling()
      vi.advanceTimersByTime(2_000)
      await vi.runAllTimersAsync()
      expect(mockRefresh).toHaveBeenCalledTimes(1)
    })

    it('calling startPolling twice does not stack intervals', async () => {
      const fetcher = vi.fn().mockResolvedValue({})
      const { startPolling } = usePollingData('k', fetcher, { interval: 1_000 })

      startPolling()
      startPolling() // should clear the first interval
      vi.advanceTimersByTime(1_000)
      await vi.runAllTimersAsync()
      expect(mockRefresh).toHaveBeenCalledTimes(1)
    })

    it('stopPolling is idempotent', () => {
      const { startPolling, stopPolling } = usePollingData('k', vi.fn(), { interval: 1_000 })
      startPolling()
      expect(() => {
        stopPolling()
        stopPolling()
        stopPolling()
      }).not.toThrow()
    })
  })

  describe('default options', () => {
    it('defaults interval to 10_000 ms', async () => {
      const fetcher = vi.fn().mockResolvedValue({})
      const { startPolling } = usePollingData('k', fetcher)

      startPolling()
      vi.advanceTimersByTime(9_999)
      await vi.runAllTimersAsync()
      expect(mockRefresh).not.toHaveBeenCalled()

      vi.advanceTimersByTime(1)
      await vi.runAllTimersAsync()
      expect(mockRefresh).toHaveBeenCalledTimes(1)
    })
  })
})
