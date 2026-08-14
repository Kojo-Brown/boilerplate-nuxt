import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { effectScope, watchSyncEffect } from 'vue'

import { debouncePlan, deferredRef, throttlePlan } from '../../../utils/deferredRef'
import type { DeferredRef } from '../../../utils/deferredRef'

/** Records every value the ref publishes, so commits can be counted. */
function observe<T>(source: { value: T }): T[] {
  const seen: T[] = []
  watchSyncEffect(() => seen.push(source.value))
  return seen
}

describe('deferredRef', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('the customRef shell', () => {
    it('reports the previous value until the plan commits', () => {
      const value = deferredRef('a', debouncePlan(100))

      value.value = 'b'

      expect(value.value).toBe('a')
      expect(value.draft.value).toBe('b')
      expect(value.pending.value).toBe(true)

      vi.advanceTimersByTime(100)

      expect(value.value).toBe('b')
      expect(value.pending.value).toBe(false)
    })

    it('notifies dependents once per commit, not once per write', () => {
      const value = deferredRef(0, debouncePlan(100))
      const seen = observe(value)

      value.value = 1
      value.value = 2
      value.value = 3
      expect(seen).toEqual([0])

      vi.advanceTimersByTime(100)

      expect(seen).toEqual([0, 3])
    })

    it('stays silent when the committed value is the one it already held', () => {
      const value = deferredRef('a', debouncePlan(100))
      const seen = observe(value)

      value.value = 'b'
      value.value = 'a'
      vi.advanceTimersByTime(100)

      expect(seen).toEqual(['a'])
      expect(value.pending.value).toBe(false)
    })

    it('keeps object identity rather than handing back a reactive proxy', () => {
      const first = { id: 1 }
      const second = { id: 2 }
      const value = deferredRef(first, debouncePlan(100))

      value.value = second
      expect(value.draft.value).toBe(second)

      vi.advanceTimersByTime(100)
      expect(value.value).toBe(second)
    })

    it('flushes the deferred write on demand', () => {
      const value = deferredRef(0, debouncePlan(100))
      const seen = observe(value)

      value.value = 7
      value.flush()

      expect(value.value).toBe(7)
      expect(seen).toEqual([0, 7])

      // The timer that was pending must not commit a second time.
      vi.advanceTimersByTime(1_000)
      expect(seen).toEqual([0, 7])
    })

    it('drops the deferred write on cancel and rewinds the draft', () => {
      const value = deferredRef('a', debouncePlan(100))
      const seen = observe(value)

      value.value = 'b'
      value.cancel()

      expect(value.draft.value).toBe('a')
      expect(value.pending.value).toBe(false)

      vi.advanceTimersByTime(1_000)

      expect(value.value).toBe('a')
      expect(seen).toEqual(['a'])
    })

    it('cancels rather than commits when the owning scope is disposed', () => {
      const scope = effectScope()
      let value!: DeferredRef<number>
      scope.run(() => {
        value = deferredRef(0, debouncePlan<number>(100))
      })
      const seen = observe(value)

      value.value = 5
      scope.stop()
      vi.advanceTimersByTime(1_000)

      expect(value.value).toBe(0)
      expect(seen).toEqual([0])
    })

    it('writes through synchronously when deferral is off', () => {
      // The path `useDebouncedRef` takes during a server render, where a timer
      // would never fire before the response is sent.
      const value = deferredRef('a', debouncePlan(100), { defer: false })
      const seen = observe(value)

      value.value = 'b'

      expect(value.value).toBe('b')
      expect(value.pending.value).toBe(false)
      expect(seen).toEqual(['a', 'b'])
    })
  })

  describe('debouncePlan', () => {
    it('restarts the wait on every write', () => {
      const value = deferredRef(0, debouncePlan(100))

      value.value = 1
      vi.advanceTimersByTime(80)
      value.value = 2
      vi.advanceTimersByTime(80)

      expect(value.value).toBe(0)

      vi.advanceTimersByTime(20)
      expect(value.value).toBe(2)
    })

    it('commits the opening write immediately with leading', () => {
      const value = deferredRef(0, debouncePlan(100, { leading: true }))
      const seen = observe(value)

      value.value = 1
      expect(seen).toEqual([0, 1])

      value.value = 2
      expect(seen).toEqual([0, 1])

      vi.advanceTimersByTime(100)
      expect(seen).toEqual([0, 1, 2])
    })

    it('commits a lone leading write exactly once', () => {
      const value = deferredRef(0, debouncePlan(100, { leading: true }))
      const seen = observe(value)

      value.value = 1
      vi.advanceTimersByTime(1_000)

      expect(seen).toEqual([0, 1])
    })

    it('starts a new burst after a quiet period', () => {
      const value = deferredRef(0, debouncePlan(100, { leading: true }))
      const seen = observe(value)

      value.value = 1
      vi.advanceTimersByTime(200)

      value.value = 2
      expect(seen).toEqual([0, 1, 2])
    })

    it('commits at maxWait even while writes keep arriving', () => {
      const value = deferredRef(0, debouncePlan(100, { maxWait: 250 }))
      const seen = observe(value)

      // A write every 50 ms: the 100 ms wait never elapses on its own.
      for (let i = 1; i <= 5; i += 1) {
        value.value = i
        vi.advanceTimersByTime(50)
      }

      expect(seen).toEqual([0, 5])
      expect(value.value).toBe(5)
    })

    it('does not leave the maxWait timer armed across bursts', () => {
      const value = deferredRef(0, debouncePlan(100, { maxWait: 250 }))
      const seen = observe(value)

      value.value = 1
      vi.advanceTimersByTime(100)
      expect(seen).toEqual([0, 1])

      // Had the maxWait timer survived the first burst it would fire here,
      // committing an already-committed value or an empty burst.
      vi.advanceTimersByTime(500)
      expect(seen).toEqual([0, 1])
    })

    it('rejects a delay that is not a usable duration', () => {
      expect(() => debouncePlan(-1)).toThrow(TypeError)
      expect(() => debouncePlan(Number.NaN)).toThrow(TypeError)
      expect(() => debouncePlan(100, { maxWait: -1 })).toThrow(TypeError)
    })
  })

  describe('throttlePlan', () => {
    it('commits the first write immediately and coalesces the rest', () => {
      const value = deferredRef(0, throttlePlan(100))
      const seen = observe(value)

      value.value = 1
      expect(seen).toEqual([0, 1])

      value.value = 2
      value.value = 3
      expect(seen).toEqual([0, 1])

      vi.advanceTimersByTime(100)
      expect(seen).toEqual([0, 1, 3])
    })

    it('keeps commits one interval apart across a continuous burst', () => {
      const value = deferredRef(0, throttlePlan(100))
      const seen = observe(value)

      // A write every 25 ms for 300 ms.
      for (let i = 1; i <= 12; i += 1) {
        value.value = i
        vi.advanceTimersByTime(25)
      }

      // t=0 leading, then the trailing commit of each window: 100, 200, 300.
      expect(seen).toEqual([0, 1, 4, 8, 12])
    })

    it('does not fire leading again immediately after a trailing commit', () => {
      const value = deferredRef(0, throttlePlan(100))
      const seen = observe(value)

      value.value = 1
      vi.advanceTimersByTime(50)
      value.value = 2
      vi.advanceTimersByTime(50)
      expect(seen).toEqual([0, 1, 2])

      // 1 ms after the trailing commit — a fresh leading commit here would
      // publish two values within the same interval.
      vi.advanceTimersByTime(1)
      value.value = 3
      expect(seen).toEqual([0, 1, 2])

      vi.advanceTimersByTime(99)
      expect(seen).toEqual([0, 1, 2, 3])
    })

    it('commits immediately again once the windows have closed', () => {
      const value = deferredRef(0, throttlePlan(100))
      const seen = observe(value)

      value.value = 1
      vi.advanceTimersByTime(1_000)
      expect(seen).toEqual([0, 1])

      value.value = 2
      expect(seen).toEqual([0, 1, 2])
    })

    it('defers the first commit to the window close without leading', () => {
      const value = deferredRef(0, throttlePlan(100, { leading: false }))
      const seen = observe(value)

      value.value = 1
      expect(seen).toEqual([0])

      vi.advanceTimersByTime(100)
      expect(seen).toEqual([0, 1])
    })

    it('drops everything after the leading write without trailing', () => {
      const value = deferredRef(0, throttlePlan(100, { trailing: false }))
      const seen = observe(value)

      value.value = 1
      value.value = 2
      vi.advanceTimersByTime(1_000)

      expect(seen).toEqual([0, 1])
      // The write is gone, so the draft is the one thing still showing it.
      expect(value.draft.value).toBe(2)
    })

    it('refuses a configuration that could never commit', () => {
      expect(() => throttlePlan(100, { leading: false, trailing: false })).toThrow(TypeError)
    })

    it('rejects an interval that is not a usable duration', () => {
      expect(() => throttlePlan(Number.POSITIVE_INFINITY)).toThrow(TypeError)
    })

    it('flushes the coalesced write and closes the window', () => {
      const value = deferredRef(0, throttlePlan(100))
      const seen = observe(value)

      value.value = 1
      value.value = 2
      value.flush()

      expect(seen).toEqual([0, 1, 2])

      vi.advanceTimersByTime(1_000)
      expect(seen).toEqual([0, 1, 2])
    })

    it('drops the coalesced write on cancel', () => {
      const value = deferredRef(0, throttlePlan(100))
      const seen = observe(value)

      value.value = 1
      value.value = 2
      value.cancel()

      vi.advanceTimersByTime(1_000)

      expect(seen).toEqual([0, 1])
      expect(value.draft.value).toBe(1)
    })
  })
})
