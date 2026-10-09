import { computed, getCurrentScope, onScopeDispose, ref } from 'vue'
import type { ComputedRef } from 'vue'

/** Where a session is between its last activity and being idle. */
export type IdlePhase = 'active' | 'warning' | 'idle'

/**
 * Arms a one-shot wake and returns the cancel for it.
 *
 * A cancel handle rather than a timer id, so the composable never has to know
 * whether it is holding a `setTimeout` id, a `requestIdleCallback` id or a
 * test's bookkeeping key.
 */
export type IdleScheduler = (callback: () => void, delayMs: number) => () => void

/**
 * The ambient values `useIdleTimeout` reads. Injected rather than reached for,
 * so a test can assert an exact instant without a real timer — see
 * `docs/composable-design-rules.md`.
 */
export interface IdleTimeoutDeps {
  /** Wall clock. Default: `Date.now`. */
  now: () => number
  /** Arms the next wake. Default: `setTimeout`. */
  schedule: IdleScheduler
  /** Where activity events are listened for. Default: `document`, or `null` off the browser. */
  target: EventTarget | null
}

export interface IdleTimeoutOptions {
  /** Milliseconds of inactivity before the session is idle. */
  timeout: number
  /**
   * Milliseconds of inactivity before the warning phase starts. Must be
   * below `timeout`. Omit for no warning phase at all.
   */
  warnAfter?: number | undefined
  /** How often `remaining` is refreshed during the warning. Default 1,000 ms. */
  tick?: number | undefined
  /** Event types on `target` that count as activity. */
  events?: readonly string[] | undefined
  /** Whether to watch at all. Default `!import.meta.server`. */
  enabled?: boolean | undefined
  onWarn?: (() => void) | undefined
  onIdle?: (() => void) | undefined
  onActive?: (() => void) | undefined
}

export interface IdleTimeout {
  phase: ComputedRef<IdlePhase>
  /** Milliseconds until idle. `0` once idle. */
  remaining: ComputedRef<number>
  isWarning: ComputedRef<boolean>
  isIdle: ComputedRef<boolean>
  /** Records activity now. Called by the DOM listeners; safe to call directly. */
  activity: () => void
  /** Stops the countdown, keeping the listeners and the current phase. */
  pause: () => void
  /** Restarts the countdown from now. */
  resume: () => void
  /** Removes the listeners and cancels the pending wake. Irreversible. */
  stop: () => void
}

/**
 * The events that mean "someone is still here".
 *
 * `pointermove` and `wheel` are in the list because a user reading a long page
 * scrolls without ever pressing a key, and being signed out mid-paragraph is
 * the bug this composable exists to avoid.
 */
export const DEFAULT_ACTIVITY_EVENTS = [
  'pointerdown',
  'pointermove',
  'keydown',
  'wheel',
  'touchstart',
] as const

/**
 * `capture` so an event stopped by a handler on the way down still counts as
 * activity, `passive` so listening on `document` cannot delay a scroll.
 */
const LISTENER_OPTIONS = { capture: true, passive: true } as const

function timerScheduler(callback: () => void, delayMs: number): () => void {
  const id = setTimeout(callback, delayMs)
  return () => clearTimeout(id)
}

function documentTarget(): EventTarget | null {
  return typeof document === 'undefined' ? null : document
}

function assertDuration(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new TypeError(`${name} must be a finite, positive number of milliseconds`)
  }
}

/**
 * Tracks how long it has been since the user did anything, and announces the
 * warning and the timeout as it passes them.
 *
 * The countdown is driven by a timestamp and a clock, not by a timer that is
 * cleared and re-armed on every event: activity records `lastActivity` and
 * nothing else, and the next wake re-derives the phase from the clock when it
 * fires. A page that samples `pointermove` at 120 Hz therefore costs one
 * assignment per sample instead of a `clearTimeout`/`setTimeout` pair.
 *
 * @example
 * ```ts
 * const { isWarning, remaining, activity } = useIdleTimeout({
 *   timeout: 15 * 60_000,
 *   warnAfter: 14 * 60_000,
 *   onIdle: () => signOut(),
 * })
 * ```
 */
export function useIdleTimeout(
  options: IdleTimeoutOptions,
  deps: Partial<IdleTimeoutDeps> = {},
): IdleTimeout {
  const { timeout, warnAfter, tick = 1_000 } = options

  assertDuration(timeout, 'timeout')
  assertDuration(tick, 'tick')
  if (warnAfter !== undefined) {
    assertDuration(warnAfter, 'warnAfter')
    if (warnAfter >= timeout) {
      throw new TypeError('warnAfter must be below timeout')
    }
  }

  const {
    events = DEFAULT_ACTIVITY_EVENTS,
    enabled = !import.meta.server,
    onWarn,
    onIdle,
    onActive,
  } = options
  const { now = Date.now, schedule = timerScheduler, target = documentTarget() } = deps

  const phase = ref<IdlePhase>('active')
  const remaining = ref(timeout)

  let lastActivity = now()
  let cancelWake: (() => void) | null = null
  let running = false
  let stopped = false

  function cancelPendingWake(): void {
    cancelWake?.()
    cancelWake = null
  }

  function announce(next: IdlePhase): void {
    const previous = phase.value
    phase.value = next
    if (next === previous) return
    if (next === 'warning') onWarn?.()
    else if (next === 'idle') onIdle?.()
    else onActive?.()
  }

  /** Reads the clock, moves to the phase it implies, and arms the next wake. */
  function wake(): void {
    const elapsed = now() - lastActivity
    cancelPendingWake()

    if (elapsed >= timeout) {
      remaining.value = 0
      announce('idle')
      return
    }

    remaining.value = timeout - elapsed

    if (warnAfter === undefined) {
      announce('active')
      cancelWake = schedule(wake, timeout - elapsed)
      return
    }

    if (elapsed < warnAfter) {
      announce('active')
      cancelWake = schedule(wake, warnAfter - elapsed)
      return
    }

    announce('warning')
    cancelWake = schedule(wake, tick)
  }

  function activity(): void {
    if (!running || phase.value === 'idle') return
    lastActivity = now()
    // While active the armed wake is already due no later than the earliest
    // possible phase change, and `wake` re-derives from the clock, so there is
    // nothing to recompute. While warning there is: the banner has to go now.
    if (phase.value !== 'active') wake()
  }

  function pause(): void {
    if (!running) return
    running = false
    cancelPendingWake()
  }

  function resume(): void {
    if (stopped || !enabled) return
    running = true
    lastActivity = now()
    remaining.value = timeout
    announce('active')
    cancelPendingWake()
    cancelWake = schedule(wake, warnAfter ?? timeout)
  }

  function stop(): void {
    if (stopped) return
    stopped = true
    running = false
    cancelPendingWake()
    if (target) {
      for (const type of events) target.removeEventListener(type, activity, LISTENER_OPTIONS)
    }
  }

  if (enabled) {
    if (target) {
      for (const type of events) target.addEventListener(type, activity, LISTENER_OPTIONS)
    }
    running = true
    cancelWake = schedule(wake, warnAfter ?? timeout)
  }

  // Guarded like the rest of the repo's composables: outside a component or an
  // `effectScope` — a plugin, a bare unit test — the caller owns teardown.
  if (getCurrentScope()) onScopeDispose(stop)

  return {
    phase: computed(() => phase.value),
    remaining: computed(() => remaining.value),
    isWarning: computed(() => phase.value === 'warning'),
    isIdle: computed(() => phase.value === 'idle'),
    activity,
    pause,
    resume,
    stop,
  }
}
