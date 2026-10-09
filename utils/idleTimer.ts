/** Where a session is between its last activity and being idle. */
export type IdlePhase = 'active' | 'warning' | 'idle'

/** A validated, fully-defaulted set of durations. */
export interface IdleTiming {
  /** Milliseconds of inactivity before the session is idle. */
  timeout: number
  /** Milliseconds of inactivity before the warning phase starts, or `null` for none. */
  warnAfter: number | null
  /** How often the warning phase refreshes the time remaining. */
  tick: number
}

export interface IdleTimingOptions {
  timeout: number
  warnAfter?: number | undefined
  tick?: number | undefined
}

/** What the clock implies right now, and when to look again. */
export interface IdleStep {
  phase: IdlePhase
  /** Milliseconds until idle, floored at `0`. */
  remaining: number
  /** Milliseconds until the next wake is worth taking, or `null` once idle. */
  delay: number | null
}

function assertDuration(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new TypeError(`${name} must be a finite, positive number of milliseconds`)
  }
}

/**
 * Checks the durations once, at construction, and fills in the defaults.
 *
 * Separate from {@link planIdleStep} so that the planner can be a total
 * function of its arguments: every `IdleTiming` it can be handed is already
 * known to be coherent, so it has no validation branches and no way to fail.
 */
export function normalizeIdleTiming(options: IdleTimingOptions): IdleTiming {
  const { timeout, warnAfter, tick = 1_000 } = options

  assertDuration(timeout, 'timeout')
  assertDuration(tick, 'tick')

  if (warnAfter !== undefined) {
    assertDuration(warnAfter, 'warnAfter')
    if (warnAfter >= timeout) {
      throw new TypeError(
        `warnAfter must be below timeout (got warnAfter=${warnAfter}, timeout=${timeout})`,
      )
    }
  }

  return { timeout, warnAfter: warnAfter ?? null, tick }
}

/**
 * The whole of the idle-timeout state machine, as a pure function of how long
 * it has been since the last activity.
 *
 * Extracted from `useIdleTimeout` in the refactor step of the kata, where the
 * same arithmetic was written out once per branch inside the timer callback and
 * so was only reachable by driving a composable to each boundary. As a
 * function it can be checked at `elapsed` exactly equal to `warnAfter`, exactly
 * equal to `timeout`, and — the case that was wrong — at a `tick` longer than
 * the time actually left. See [`docs/tdd-kata.md`](../docs/tdd-kata.md).
 *
 * @param elapsed Milliseconds since the last activity.
 */
export function planIdleStep(elapsed: number, timing: IdleTiming): IdleStep {
  // A clock that has gone backwards — an NTP resync, a laptop waking with a
  // corrected time — reports a negative elapsed. Clamping reads that as "no
  // time has passed", which postpones idling by at most the size of the jump.
  // Reading it literally would be the other way round, and signing a user out
  // because their machine corrected its clock is the worse failure. Inject
  // `performance.now` as `now` where a monotonic clock is wanted instead.
  const since = Math.max(0, elapsed)
  const remaining = Math.max(0, timing.timeout - since)

  if (remaining === 0) {
    return { phase: 'idle', remaining: 0, delay: null }
  }

  if (timing.warnAfter === null) {
    // Nothing to show between now and the timeout, so there is nothing to wake
    // up for either.
    return { phase: 'active', remaining, delay: remaining }
  }

  if (since < timing.warnAfter) {
    return { phase: 'active', remaining, delay: timing.warnAfter - since }
  }

  // `min` rather than `tick`: a tick that does not divide the warning window
  // would otherwise carry the next wake past the timeout, and idle would be
  // announced late by up to a whole tick.
  return { phase: 'warning', remaining, delay: Math.min(timing.tick, remaining) }
}
