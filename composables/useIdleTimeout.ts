import { computed, getCurrentScope, onScopeDispose, ref } from 'vue'
import type { ComputedRef } from 'vue'

import { normalizeIdleTiming, planIdleStep } from '../utils/idleTimer'
// `IdlePhase` is deliberately not re-exported: both directories are
// auto-imported, so a second export of the same name makes Nuxt pick one and
// warn about the other. Import it from `utils/idleTimer` (or let the
// auto-import do it).
import type { IdlePhase, IdleTimingOptions } from '../utils/idleTimer'

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

export interface IdleTimeoutOptions extends IdleTimingOptions {
  /** Event types on `target` that count as activity. Default: {@link DEFAULT_ACTIVITY_EVENTS}. */
  events?: readonly string[] | undefined
  /** Whether to watch at all. Default `!import.meta.server`. */
  enabled?: boolean | undefined
  /** Called once when the warning phase starts. */
  onWarn?: (() => void) | undefined
  /** Called once when the session goes idle. */
  onIdle?: (() => void) | undefined
  /** Called once when a warned or idle session returns to active. */
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
  /** Restarts the countdown from now, including from idle. */
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
 * `capture` so an event a handler stops on the way down still counts as
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

/**
 * Tracks how long it has been since the user did anything, and announces the
 * warning and the timeout as it passes them.
 *
 * The countdown is a timestamp and a clock, not a timer that is cleared and
 * re-armed on every event: `activity()` records `lastActivity` and nothing
 * else, and the next wake re-derives the phase from the clock when it fires. A
 * page that samples `pointermove` at 120 Hz therefore costs one assignment per
 * sample instead of a `clearTimeout`/`setTimeout` pair, and a wake that lands
 * earlier than the last activity deserves simply arms itself again.
 *
 * What it decides is in {@link planIdleStep}; this is the shell that owns the
 * clock, the listeners and the refs. Built as the kata in
 * [`docs/tdd-kata.md`](../docs/tdd-kata.md).
 *
 * @example
 * ```ts
 * const { isWarning, remaining, activity } = useIdleTimeout({
 *   timeout: 15 * 60_000,
 *   warnAfter: 14 * 60_000,
 *   onIdle: () => signOut(),
 * })
 * ```
 *
 * @param deps Overrides for the ambient values in {@link IdleTimeoutDeps}. Every
 *   field is optional and defaults to the real thing, so application code calls
 *   `useIdleTimeout(options)` and only tests pass anything.
 */
export function useIdleTimeout(
  options: IdleTimeoutOptions,
  deps: Partial<IdleTimeoutDeps> = {},
): IdleTimeout {
  const timing = normalizeIdleTiming(options)

  const {
    events = DEFAULT_ACTIVITY_EVENTS,
    enabled = !import.meta.server,
    onWarn,
    onIdle,
    onActive,
  } = options
  const { now = Date.now, schedule = timerScheduler, target = documentTarget() } = deps

  const phase = ref<IdlePhase>('active')
  const remaining = ref(timing.timeout)

  let lastActivity = now()
  let cancelWake: (() => void) | null = null
  let running = false
  let stopped = false

  function cancelPendingWake(): void {
    cancelWake?.()
    cancelWake = null
  }

  /** Transitions only: a tick that changed nothing must not re-announce it. */
  function announce(next: IdlePhase): void {
    const previous = phase.value
    phase.value = next
    if (next === previous) return
    if (next === 'warning') onWarn?.()
    else if (next === 'idle') onIdle?.()
    else onActive?.()
  }

  /** Reads the clock, applies the step it implies, and arms the next wake. */
  function wake(): void {
    cancelPendingWake()

    const step = planIdleStep(now() - lastActivity, timing)
    remaining.value = step.remaining
    announce(step.phase)

    if (step.delay !== null) cancelWake = schedule(wake, step.delay)
  }

  function activity(): void {
    if (!running || phase.value === 'idle') return
    lastActivity = now()
    // While active the armed wake is already due no later than the earliest
    // possible phase change, and `wake` re-derives from the clock, so there is
    // nothing to recompute — which is what keeps a `pointermove` storm free.
    // While warning there is: the banner has to go now, not at the next tick.
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
    wake()
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
    wake()
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
