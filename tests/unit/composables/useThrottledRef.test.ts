import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { watchSyncEffect } from 'vue'

import { useThrottledRef } from '../../../composables/useThrottledRef'

describe('useThrottledRef', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('holds the initial value without deferring it', () => {
    const offset = useThrottledRef(120)

    expect(offset.value).toBe(120)
    expect(offset.pending.value).toBe(false)
  })

  it('publishes movement at a steady rate instead of only at the end', () => {
    const offset = useThrottledRef(0, 100)
    const published: number[] = []
    watchSyncEffect(() => published.push(offset.value))

    // A scroll handler firing every 20 ms for half a second.
    for (let frame = 1; frame <= 25; frame += 1) {
      offset.value = frame * 10
      vi.advanceTimersByTime(20)
    }

    // Leading commit, then one per closed window — the point of throttling
    // rather than debouncing: the intermediate positions are not thrown away.
    expect(published).toEqual([0, 10, 50, 100, 150, 200, 250])
  })

  it('always publishes the last value of a burst', () => {
    const offset = useThrottledRef(0, 100)

    offset.value = 5
    offset.value = 40
    offset.value = 99

    expect(offset.value).toBe(5)

    vi.advanceTimersByTime(100)

    expect(offset.value).toBe(99)
    expect(offset.pending.value).toBe(false)
  })

  it('defaults to a 300 ms interval', () => {
    const offset = useThrottledRef(0)

    offset.value = 1
    offset.value = 2
    vi.advanceTimersByTime(299)
    expect(offset.value).toBe(1)

    vi.advanceTimersByTime(1)
    expect(offset.value).toBe(2)
  })

  it('waits out the interval before the first commit without leading', () => {
    const offset = useThrottledRef(0, 100, { leading: false })
    const published: number[] = []
    watchSyncEffect(() => published.push(offset.value))

    offset.value = 7
    expect(published).toEqual([0])

    vi.advanceTimersByTime(100)
    expect(published).toEqual([0, 7])
  })

  it('publishes on flush without waiting for the window to close', () => {
    const offset = useThrottledRef(0, 1_000)

    offset.value = 1
    offset.value = 2
    offset.flush()

    expect(offset.value).toBe(2)
  })

  it('drops the coalesced write on cancel', () => {
    const offset = useThrottledRef(0, 100)

    offset.value = 1
    offset.value = 2
    offset.cancel()
    vi.advanceTimersByTime(1_000)

    expect(offset.value).toBe(1)
    expect(offset.pending.value).toBe(false)
  })

  it('rejects a configuration that would never publish anything', () => {
    expect(() => useThrottledRef(0, 100, { leading: false, trailing: false })).toThrow(TypeError)
  })
})
