import { describe, expect, it, vi } from 'vitest'
import { effectScope } from 'vue'

import { useIdleTimeout } from '../../../composables/useIdleTimeout'
import type { IdleScheduler, IdleTimeoutOptions } from '../../../composables/useIdleTimeout'

/**
 * The kata spec. Written before `composables/useIdleTimeout.ts` existed — see
 * [`docs/tdd-kata.md`](../../../docs/tdd-kata.md), which records what each
 * commit on the branch changed and why it was the next thing to do.
 *
 * Every test here drives the composable through injected dependencies rather
 * than `vi.useFakeTimers()`. That is Rule 2 of
 * `docs/composable-design-rules.md` used for what it is for: the clock, the
 * scheduler and the activity source are seams, so the spec can say "idle fires
 * at exactly 10,000 ms after the last activity" without a real timer and
 * without patching a global. It also keeps the assertions about the
 * composable's contract rather than about `setTimeout`.
 */

const TIMEOUT = 10_000
const WARN_AFTER = 6_000
const TICK = 2_000

interface FakeClock {
  now: () => number
  schedule: IdleScheduler
  /** Moves time forward, firing every timer that comes due on the way. */
  advance: (ms: number) => void
  /** Timers armed and neither fired nor cancelled. */
  pending: () => number
  /** Timers armed since the clock was created, whatever became of them. */
  armed: () => number
}

/**
 * A clock whose timers fire only when the test says so.
 *
 * `advance` walks the queue in due order instead of firing everything that
 * falls inside the window, because the composable arms its next wake from
 * inside a wake. Firing out of order would let a timer observe a clock reading
 * from after the moment it was actually due, which is the one thing a fake
 * clock must not get wrong for a spec that asserts exact instants.
 */
function createFakeClock(start = 1_700_000_000_000): FakeClock {
  interface Timer {
    at: number
    run: () => void
  }

  let current = start
  let nextId = 0
  let armed = 0
  const timers = new Map<number, Timer>()

  return {
    now: () => current,
    schedule(callback, delayMs) {
      const id = nextId++
      armed += 1
      timers.set(id, { at: current + delayMs, run: callback })
      return () => {
        timers.delete(id)
      }
    },
    advance(ms) {
      const target = current + ms

      for (;;) {
        let due: { id: number; at: number; run: () => void } | null = null
        for (const [id, timer] of timers) {
          if (timer.at <= target && (due === null || timer.at < due.at)) {
            due = { id, at: timer.at, run: timer.run }
          }
        }
        if (due === null) break

        timers.delete(due.id)
        current = due.at
        due.run()
      }

      current = target
    },
    pending: () => timers.size,
    armed: () => armed,
  }
}

/** A real `EventTarget`, with its listener bookkeeping observable. */
function createTarget() {
  const target = new EventTarget()
  return {
    target,
    add: vi.spyOn(target, 'addEventListener'),
    remove: vi.spyOn(target, 'removeEventListener'),
    fire: (type: string) => target.dispatchEvent(new Event(type)),
  }
}

function setup(
  options: Partial<IdleTimeoutOptions> = {},
  deps: { target?: EventTarget | null } = {},
) {
  const clock = createFakeClock()
  const dom = createTarget()
  const onWarn = vi.fn()
  const onIdle = vi.fn()
  const onActive = vi.fn()

  const idle = useIdleTimeout(
    {
      timeout: TIMEOUT,
      warnAfter: WARN_AFTER,
      tick: TICK,
      events: ['keydown', 'pointermove'],
      onWarn,
      onIdle,
      onActive,
      ...options,
    },
    {
      now: clock.now,
      schedule: clock.schedule,
      target: deps.target === undefined ? dom.target : deps.target,
    },
  )

  return { idle, clock, dom, onWarn, onIdle, onActive }
}

describe('useIdleTimeout', () => {
  describe('phases', () => {
    it('starts active with the whole timeout remaining', () => {
      const { idle } = setup()

      expect(idle.phase.value).toBe('active')
      expect(idle.isWarning.value).toBe(false)
      expect(idle.isIdle.value).toBe(false)
      expect(idle.remaining.value).toBe(TIMEOUT)
    })

    it('stays active until the instant before the warning point', () => {
      const { idle, clock, onWarn } = setup()

      clock.advance(WARN_AFTER - 1)

      expect(idle.phase.value).toBe('active')
      expect(onWarn).not.toHaveBeenCalled()
    })

    it('enters the warning phase at warnAfter and calls onWarn once', () => {
      const { idle, clock, onWarn } = setup()

      clock.advance(WARN_AFTER)

      expect(idle.phase.value).toBe('warning')
      expect(idle.isWarning.value).toBe(true)
      expect(idle.isIdle.value).toBe(false)
      expect(idle.remaining.value).toBe(TIMEOUT - WARN_AFTER)
      expect(onWarn).toHaveBeenCalledTimes(1)
    })

    it('refreshes remaining once per tick while warning', () => {
      const { idle, clock, onWarn } = setup()

      clock.advance(WARN_AFTER)
      expect(idle.remaining.value).toBe(4_000)

      clock.advance(TICK)
      expect(idle.remaining.value).toBe(2_000)
      expect(idle.phase.value).toBe('warning')
      // The phase did not change, so the warning is not announced again.
      expect(onWarn).toHaveBeenCalledTimes(1)
    })

    it('goes idle at the timeout and calls onIdle once', () => {
      const { idle, clock, onIdle } = setup()

      clock.advance(TIMEOUT)

      expect(idle.phase.value).toBe('idle')
      expect(idle.isIdle.value).toBe(true)
      expect(idle.isWarning.value).toBe(false)
      expect(idle.remaining.value).toBe(0)
      expect(onIdle).toHaveBeenCalledTimes(1)
    })

    it('treats idle as terminal: it arms no further wake', () => {
      const { clock, onIdle } = setup()

      clock.advance(TIMEOUT)
      expect(clock.pending()).toBe(0)

      clock.advance(TIMEOUT * 10)
      expect(onIdle).toHaveBeenCalledTimes(1)
    })

    it('runs without a warning phase when warnAfter is omitted', () => {
      const { idle, clock, onWarn, onIdle } = setup({ warnAfter: undefined })

      clock.advance(TIMEOUT - 1)
      expect(idle.phase.value).toBe('active')
      expect(onWarn).not.toHaveBeenCalled()

      clock.advance(1)
      expect(idle.phase.value).toBe('idle')
      expect(onWarn).not.toHaveBeenCalled()
      expect(onIdle).toHaveBeenCalledTimes(1)
    })
  })

  describe('activity', () => {
    it('postpones idling to a full timeout after the last activity', () => {
      const { idle, clock, onIdle } = setup()

      clock.advance(5_000)
      idle.activity()

      clock.advance(5_000)
      expect(idle.phase.value).not.toBe('idle')
      expect(onIdle).not.toHaveBeenCalled()

      clock.advance(5_000)
      expect(idle.phase.value).toBe('idle')
      expect(onIdle).toHaveBeenCalledTimes(1)
    })

    it('counts a configured DOM event on the target as activity', () => {
      const { clock, dom, onIdle } = setup()

      clock.advance(5_000)
      dom.fire('keydown')

      clock.advance(5_000)
      expect(onIdle).not.toHaveBeenCalled()

      clock.advance(5_000)
      expect(onIdle).toHaveBeenCalledTimes(1)
    })

    it('ignores an event type it was not configured to watch', () => {
      const { clock, dom, onIdle } = setup()

      clock.advance(5_000)
      dom.fire('scroll')

      clock.advance(5_000)
      expect(onIdle).toHaveBeenCalledTimes(1)
    })

    it('leaves the warning phase at once, without waiting for the next tick', () => {
      const { idle, clock, onActive } = setup()

      clock.advance(WARN_AFTER)
      expect(idle.phase.value).toBe('warning')

      idle.activity()

      expect(idle.phase.value).toBe('active')
      expect(idle.remaining.value).toBe(TIMEOUT)
      expect(onActive).toHaveBeenCalledTimes(1)
    })

    it('is ignored once idle', () => {
      const { idle, clock, onActive } = setup()

      clock.advance(TIMEOUT)
      idle.activity()

      expect(idle.phase.value).toBe('idle')
      expect(onActive).not.toHaveBeenCalled()
    })

    it('arms no extra timer per activity event while active', () => {
      const { clock, dom } = setup()

      expect(clock.armed()).toBe(1)

      for (let i = 0; i < 50; i += 1) dom.fire('pointermove')

      // The whole point of recording a timestamp instead of re-arming a timer:
      // a mousemove storm costs one assignment per event, not one
      // clearTimeout/setTimeout pair.
      expect(clock.armed()).toBe(1)
      expect(clock.pending()).toBe(1)
    })

    it('re-derives the phase from the clock when a wake lands early', () => {
      const { idle, clock, onWarn } = setup()

      clock.advance(5_000)
      idle.activity()

      // The wake armed at construction is still due at 6,000 ms, but by then
      // only 1,000 ms have passed since the last activity. It must re-arm, not
      // announce a warning.
      clock.advance(1_000)

      expect(idle.phase.value).toBe('active')
      expect(idle.remaining.value).toBe(TIMEOUT - 1_000)
      expect(onWarn).not.toHaveBeenCalled()
      expect(clock.pending()).toBe(1)

      clock.advance(5_000)
      expect(idle.phase.value).toBe('warning')
      expect(onWarn).toHaveBeenCalledTimes(1)
    })
  })

  describe('lifecycle', () => {
    it('attaches one listener per configured event', () => {
      const { dom } = setup()

      expect(dom.add.mock.calls.map((call) => call[0])).toEqual(['keydown', 'pointermove'])
    })

    it('stop() removes every listener and cancels the pending wake', () => {
      const { idle, clock, dom, onIdle } = setup()

      idle.stop()

      expect(dom.remove.mock.calls.map((call) => call[0])).toEqual(['keydown', 'pointermove'])
      expect(clock.pending()).toBe(0)

      clock.advance(TIMEOUT * 2)
      expect(onIdle).not.toHaveBeenCalled()
    })

    it('stop() is idempotent', () => {
      const { idle, dom } = setup()

      idle.stop()
      idle.stop()

      expect(dom.remove).toHaveBeenCalledTimes(2)
    })

    it('pause() cancels the pending wake and freezes the phase', () => {
      const { idle, clock, onIdle } = setup()

      clock.advance(WARN_AFTER)
      idle.pause()

      expect(clock.pending()).toBe(0)

      clock.advance(TIMEOUT * 2)
      expect(idle.phase.value).toBe('warning')
      expect(onIdle).not.toHaveBeenCalled()
    })

    it('resume() restarts the countdown from now', () => {
      const { idle, clock, onIdle } = setup()

      clock.advance(WARN_AFTER)
      idle.pause()
      clock.advance(TIMEOUT * 2)

      idle.resume()

      expect(idle.phase.value).toBe('active')
      expect(idle.remaining.value).toBe(TIMEOUT)

      clock.advance(TIMEOUT - 1)
      expect(onIdle).not.toHaveBeenCalled()

      clock.advance(1)
      expect(onIdle).toHaveBeenCalledTimes(1)
    })

    it('resume() revives a timer that has already gone idle', () => {
      const { idle, clock } = setup()

      clock.advance(TIMEOUT)
      expect(idle.phase.value).toBe('idle')

      idle.resume()

      expect(idle.phase.value).toBe('active')
      expect(idle.remaining.value).toBe(TIMEOUT)
    })

    it('resume() does nothing after stop()', () => {
      const { idle, clock, onIdle } = setup()

      idle.stop()
      idle.resume()

      clock.advance(TIMEOUT * 2)
      expect(onIdle).not.toHaveBeenCalled()
    })

    it('disposing the surrounding effect scope stops it', () => {
      const clock = createFakeClock()
      const dom = createTarget()
      const onIdle = vi.fn()
      const scope = effectScope()

      scope.run(() => {
        useIdleTimeout(
          { timeout: TIMEOUT, events: ['keydown'], onIdle },
          { now: clock.now, schedule: clock.schedule, target: dom.target },
        )
      })

      scope.stop()

      expect(dom.remove).toHaveBeenCalledTimes(1)
      expect(clock.pending()).toBe(0)

      clock.advance(TIMEOUT * 2)
      expect(onIdle).not.toHaveBeenCalled()
    })
  })

  describe('without an activity source', () => {
    it('still counts down and can be fed by activity() alone', () => {
      const { idle, clock, onIdle } = setup({}, { target: null })

      clock.advance(5_000)
      idle.activity()

      clock.advance(TIMEOUT - 1)
      expect(onIdle).not.toHaveBeenCalled()

      clock.advance(1)
      expect(idle.phase.value).toBe('idle')
      expect(onIdle).toHaveBeenCalledTimes(1)
    })
  })

  describe('when disabled', () => {
    it('attaches nothing, arms nothing, and never goes idle', () => {
      const { idle, clock, dom, onWarn, onIdle } = setup({ enabled: false })

      expect(dom.add).not.toHaveBeenCalled()
      expect(clock.armed()).toBe(0)

      clock.advance(TIMEOUT * 10)

      expect(idle.phase.value).toBe('active')
      expect(idle.isIdle.value).toBe(false)
      expect(idle.remaining.value).toBe(TIMEOUT)
      expect(onWarn).not.toHaveBeenCalled()
      expect(onIdle).not.toHaveBeenCalled()
    })

    it('keeps resume() inert, so an SSR render cannot start a timer', () => {
      const { idle, clock, onIdle } = setup({ enabled: false })

      idle.resume()
      clock.advance(TIMEOUT * 2)

      expect(clock.armed()).toBe(0)
      expect(onIdle).not.toHaveBeenCalled()
    })
  })

  describe('option validation', () => {
    it.each([
      { timeout: 0 },
      { timeout: -1 },
      { timeout: Number.NaN },
      { timeout: Number.POSITIVE_INFINITY },
    ])('rejects a timeout of $timeout', ({ timeout }) => {
      expect(() => useIdleTimeout({ timeout })).toThrow(TypeError)
    })

    it('rejects a warnAfter at or past the timeout', () => {
      expect(() => useIdleTimeout({ timeout: 1_000, warnAfter: 1_000 })).toThrow(TypeError)
      expect(() => useIdleTimeout({ timeout: 1_000, warnAfter: 1_001 })).toThrow(TypeError)
    })

    it('rejects a non-positive warnAfter', () => {
      expect(() => useIdleTimeout({ timeout: 1_000, warnAfter: 0 })).toThrow(TypeError)
    })

    it('rejects a non-positive tick', () => {
      expect(() => useIdleTimeout({ timeout: 1_000, tick: 0 })).toThrow(TypeError)
    })
  })
})
