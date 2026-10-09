import { describe, expect, it } from 'vitest'

import { normalizeIdleTiming, planIdleStep } from '../../../utils/idleTimer'
import type { IdleTiming } from '../../../utils/idleTimer'

/**
 * The refactor step of the kata in [`docs/tdd-kata.md`](../../../docs/tdd-kata.md)
 * exists to make these tests possible. Until `planIdleStep` was a function, the
 * same arithmetic lived in three branches of a timer callback and the only way
 * to reach a boundary was to drive the whole composable to it — which is why
 * the `tick` case below had been wrong since the green step and had nothing
 * failing on it.
 */

const WARNED: IdleTiming = { timeout: 10_000, warnAfter: 6_000, tick: 1_000 }
const SILENT: IdleTiming = { timeout: 10_000, warnAfter: null, tick: 1_000 }

describe('normalizeIdleTiming', () => {
  it('defaults the tick to a second and the warning to none', () => {
    expect(normalizeIdleTiming({ timeout: 10_000 })).toEqual({
      timeout: 10_000,
      warnAfter: null,
      tick: 1_000,
    })
  })

  it('keeps the durations it was given', () => {
    expect(normalizeIdleTiming({ timeout: 10_000, warnAfter: 6_000, tick: 500 })).toEqual({
      timeout: 10_000,
      warnAfter: 6_000,
      tick: 500,
    })
  })

  it.each([{ timeout: 0 }, { timeout: -1 }, { timeout: Number.NaN }, { timeout: Infinity }])(
    'rejects a timeout of $timeout',
    (options) => {
      expect(() => normalizeIdleTiming(options)).toThrow(TypeError)
    },
  )

  it.each([0, -1, Number.NaN])('rejects a tick of %s', (tick) => {
    expect(() => normalizeIdleTiming({ timeout: 10_000, tick })).toThrow(TypeError)
  })

  it.each([0, -1, Number.NaN])('rejects a warnAfter of %s', (warnAfter) => {
    expect(() => normalizeIdleTiming({ timeout: 10_000, warnAfter })).toThrow(TypeError)
  })

  it('rejects a warning that would never be seen', () => {
    expect(() => normalizeIdleTiming({ timeout: 10_000, warnAfter: 10_000 })).toThrow(
      /warnAfter must be below timeout/,
    )
    expect(() => normalizeIdleTiming({ timeout: 10_000, warnAfter: 10_001 })).toThrow(TypeError)
  })
})

describe('planIdleStep', () => {
  describe('with a warning phase', () => {
    it('waits out the whole lead-in before waking', () => {
      expect(planIdleStep(0, WARNED)).toEqual({ phase: 'active', remaining: 10_000, delay: 6_000 })
    })

    it('is still active one millisecond before the warning', () => {
      expect(planIdleStep(5_999, WARNED)).toEqual({ phase: 'active', remaining: 4_001, delay: 1 })
    })

    it('warns at exactly warnAfter, not after it', () => {
      expect(planIdleStep(6_000, WARNED)).toEqual({
        phase: 'warning',
        remaining: 4_000,
        delay: 1_000,
      })
    })

    it('ticks through the warning window', () => {
      expect(planIdleStep(7_000, WARNED)).toEqual({
        phase: 'warning',
        remaining: 3_000,
        delay: 1_000,
      })
    })

    it('shortens the last wake so the tick cannot overshoot the timeout', () => {
      // The bug the refactor found. `delay: tick` here would put the next wake
      // at 10,500 ms and announce idle 500 ms late.
      expect(planIdleStep(9_500, WARNED)).toEqual({ phase: 'warning', remaining: 500, delay: 500 })
    })

    it('handles a tick longer than the entire warning window', () => {
      const coarse: IdleTiming = { timeout: 10_000, warnAfter: 9_000, tick: 5_000 }
      expect(planIdleStep(9_000, coarse)).toEqual({
        phase: 'warning',
        remaining: 1_000,
        delay: 1_000,
      })
    })

    it('is idle at exactly the timeout', () => {
      expect(planIdleStep(10_000, WARNED)).toEqual({ phase: 'idle', remaining: 0, delay: null })
    })

    it('stays idle, and arms nothing, long past the timeout', () => {
      expect(planIdleStep(10_000_000, WARNED)).toEqual({
        phase: 'idle',
        remaining: 0,
        delay: null,
      })
    })
  })

  describe('without a warning phase', () => {
    it('sleeps until the timeout rather than ticking', () => {
      expect(planIdleStep(0, SILENT)).toEqual({ phase: 'active', remaining: 10_000, delay: 10_000 })
    })

    it('is active one millisecond before the timeout', () => {
      expect(planIdleStep(9_999, SILENT)).toEqual({ phase: 'active', remaining: 1, delay: 1 })
    })

    it('never reports the warning phase', () => {
      for (let elapsed = 0; elapsed < 10_000; elapsed += 137) {
        expect(planIdleStep(elapsed, SILENT).phase).toBe('active')
      }
    })
  })

  describe('a clock that goes backwards', () => {
    it('reads a negative elapsed as no time passed', () => {
      // Signing a user out because their machine resynced NTP is the worse
      // failure, so the jump postpones idling rather than causing it.
      expect(planIdleStep(-5_000, WARNED)).toEqual({
        phase: 'active',
        remaining: 10_000,
        delay: 6_000,
      })
    })
  })

  describe('invariants', () => {
    it.each([WARNED, SILENT, { timeout: 7_777, warnAfter: 1, tick: 3_000 }])(
      'never arms a wake past the timeout (%j)',
      (timing) => {
        for (let elapsed = -500; elapsed <= timing.timeout + 500; elapsed += 1) {
          const step = planIdleStep(elapsed, timing)
          if (step.delay === null) continue
          expect(step.delay).toBeGreaterThan(0)
          expect(Math.max(0, elapsed) + step.delay).toBeLessThanOrEqual(timing.timeout)
        }
      },
    )

    it.each([WARNED, SILENT])(
      'reports remaining as the time left, floored at zero (%j)',
      (timing) => {
        for (let elapsed = -500; elapsed <= timing.timeout + 500; elapsed += 1) {
          const step = planIdleStep(elapsed, timing)
          expect(step.remaining).toBe(Math.max(0, timing.timeout - Math.max(0, elapsed)))
          expect(step.phase === 'idle').toBe(step.remaining === 0)
        }
      },
    )
  })
})
