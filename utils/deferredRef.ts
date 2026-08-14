import { computed, customRef, getCurrentScope, onScopeDispose, shallowRef } from 'vue'
import type { ComputedRef, Ref } from 'vue'

/**
 * A ref whose writes reach readers later than they were made.
 *
 * It is a real `Ref<T>`, so it works with `v-model`, `watch`, and `computed`
 * unchanged — the deferral is invisible to anything that only reads `.value`.
 * The extra members describe the gap between "written" and "visible".
 *
 * The members are properties on the ref object, not values inside it, which
 * matters in templates: a top-level ref is auto-unwrapped there, so
 * `search.pending` in a template reads a property of the *unwrapped* value and
 * is always `undefined`. Destructure in `<script setup>` instead —
 * `const { pending, flush } = search` — and use `pending` directly.
 */
export interface DeferredRef<T> extends Ref<T> {
  /**
   * The most recent value written, whether or not it has been committed. This
   * is what an input bound with `v-model` is showing while the ref itself
   * still reports the previous value.
   */
  readonly draft: Readonly<Ref<T>>
  /** True while `draft` has not reached the ref yet. */
  readonly pending: ComputedRef<boolean>
  /**
   * Commits the deferred write now and closes the current window. No-op when
   * nothing is deferred. Use it when an event should not wait out the delay —
   * form submit, `Enter`, a blur.
   */
  flush: () => void
  /**
   * Discards the deferred write; `draft` returns to the committed value. Use
   * it when the write has been superseded — the search box was cleared, the
   * dialog was dismissed.
   */
  cancel: () => void
}

/**
 * Receives every write and decides when — if ever — to hand it to `commit`.
 *
 * Split out from {@link deferredRef} because debounce and throttle differ only
 * in this decision. Everything else — tracking, triggering, `draft`,
 * `pending`, teardown, the server-render path — is identical and lives in the
 * shell.
 */
export interface CommitPlan<T> {
  /** Called on every write to the ref. */
  write: (value: T) => void
  /** Commit whatever is deferred right now. */
  flush: () => void
  /** Drop whatever is deferred without committing it. */
  cancel: () => void
}

/** Builds a {@link CommitPlan} bound to the ref's `commit` function. */
export type CommitPlanner<T> = (commit: (value: T) => void) => CommitPlan<T>

export interface DeferredRefOptions {
  /**
   * Whether writes are deferred at all. `false` makes the ref behave exactly
   * like `ref()`, which is what the server needs: a render pass finishes long
   * before any `setTimeout` fires, so a deferred write there is not delayed,
   * it is dropped. The composables pass `!import.meta.server`.
   */
  defer?: boolean
}

/**
 * The `customRef` shell shared by {@link useDebouncedRef} and
 * {@link useThrottledRef}.
 *
 * `customRef` exists for exactly this: it hands you `track` and `trigger` so a
 * ref can decouple *when a value is written* from *when dependents are told*.
 * A `watch` with a timer cannot do the same job — it fires after the value has
 * already changed, so everything else watching the source has already re-run.
 * Here, nothing observes the write until the plan commits it, so a debounced
 * search box drives one query instead of one per keystroke, without any
 * caller needing to know the value is debounced.
 *
 * Teardown cancels rather than flushes. A component that has gone away is not
 * waiting for the value, and committing during disposal would notify watchers
 * that are themselves being torn down.
 */
export function deferredRef<T>(
  initial: T,
  planner: CommitPlanner<T>,
  options: DeferredRefOptions = {},
): DeferredRef<T> {
  const { defer = true } = options

  let current = initial
  let trigger: (() => void) | null = null

  // `shallowRef` on purpose: `draft` mirrors whatever the caller wrote and must
  // not deep-proxy it, or an object written to the ref would come back out of
  // `draft` as a different (reactive) object than the one the ref reports. For
  // the same reason it is exposed as readonly at the type level only —
  // `readonly()` would reintroduce the proxy this avoids.
  const draft: Ref<T> = shallowRef(initial)

  function commit(value: T): void {
    draft.value = value
    // Matches `ref()`: writing the value it already holds notifies nobody.
    if (Object.is(current, value)) return
    current = value
    trigger?.()
  }

  const plan = planner(commit)

  const inner = customRef<T>((track, notify) => {
    trigger = notify
    return {
      get() {
        track()
        return current
      },
      set(value) {
        // `draft` moves immediately even though the ref does not — that gap is
        // the whole point, and `pending` is derived from it.
        draft.value = value
        if (defer) plan.write(value)
        else commit(value)
      },
    }
  })

  // Reads `inner.value` rather than the `current` closure variable so the
  // computed tracks the ref and re-evaluates when a commit triggers it.
  const pending = computed(() => !Object.is(draft.value, inner.value))

  function cancel(): void {
    plan.cancel()
    draft.value = current
  }

  // Guarded like the rest of the repo's composables: outside a component or an
  // `effectScope` — a plugin, a bare unit test — the caller owns teardown.
  if (getCurrentScope()) {
    onScopeDispose(cancel)
  }

  return Object.assign(inner, {
    draft: draft as Readonly<Ref<T>>,
    pending,
    flush: plan.flush,
    cancel,
  }) as DeferredRef<T>
}

export interface DebouncePlanOptions {
  /**
   * Commit the write that opens a burst immediately, then debounce the rest.
   * Default `false`. With `leading: true` and no further writes the burst
   * commits once, at the start.
   */
  leading?: boolean
  /**
   * Upper bound on how long a write may sit deferred, in milliseconds.
   * Without it, a caller who keeps writing faster than `delay` never sees a
   * commit at all — the classic "type slowly forever, search never runs" bug.
   */
  maxWait?: number
}

/**
 * Commits `delay` ms after the last write in a burst.
 *
 * The burst ends at the first quiet gap of `delay`, or at `maxWait` after it
 * started, whichever comes first.
 */
export function debouncePlan<T>(
  delay: number,
  options: DebouncePlanOptions = {},
): CommitPlanner<T> {
  const { leading = false, maxWait } = options

  assertDuration(delay, 'delay')
  if (maxWait !== undefined) assertDuration(maxWait, 'maxWait')

  return (commit) => {
    let timer: ReturnType<typeof setTimeout> | null = null
    let maxTimer: ReturnType<typeof setTimeout> | null = null
    let latest: T | undefined
    let deferred = false
    let bursting = false

    function clearTimers(): void {
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
      if (maxTimer !== null) {
        clearTimeout(maxTimer)
        maxTimer = null
      }
    }

    function settle(): void {
      clearTimers()
      bursting = false
      if (!deferred) return
      const value = latest as T
      deferred = false
      latest = undefined
      commit(value)
    }

    return {
      write(value) {
        latest = value
        deferred = true

        if (!bursting) {
          bursting = true
          if (leading) {
            deferred = false
            latest = undefined
            commit(value)
          }
          if (maxWait !== undefined) {
            maxTimer = setTimeout(settle, maxWait)
          }
        }

        if (timer !== null) clearTimeout(timer)
        timer = setTimeout(settle, delay)
      },
      flush: settle,
      cancel() {
        clearTimers()
        bursting = false
        deferred = false
        latest = undefined
      },
    }
  }
}

export interface ThrottlePlanOptions {
  /** Commit the write that opens a window immediately. Default `true`. */
  leading?: boolean
  /**
   * Commit the last write of a window when the window closes. Default `true`.
   * With `trailing: false` the final value of a burst is dropped unless it
   * happened to be the leading one, which is rarely what a UI wants.
   */
  trailing?: boolean
}

/**
 * Commits at most once per `interval` ms, keeping the newest write.
 *
 * Unlike debounce, a steady stream of writes still produces steady commits —
 * which is what a drag handler or a scroll position needs, where the caller
 * wants to see movement rather than only the destination.
 */
export function throttlePlan<T>(
  interval: number,
  options: ThrottlePlanOptions = {},
): CommitPlanner<T> {
  const { leading = true, trailing = true } = options

  assertDuration(interval, 'interval')
  if (!leading && !trailing) {
    throw new TypeError(
      'leading and trailing cannot both be false — no write would ever be committed',
    )
  }

  return (commit) => {
    let timer: ReturnType<typeof setTimeout> | null = null
    let latest: T | undefined
    let deferred = false

    function take(): T {
      const value = latest as T
      deferred = false
      latest = undefined
      return value
    }

    function openWindow(): void {
      timer = setTimeout(closeWindow, interval)
    }

    function closeWindow(): void {
      timer = null
      if (!deferred) return
      if (!trailing) {
        // Discarded rather than left sitting, so a later `flush()` cannot
        // resurrect a write this window already decided to drop.
        take()
        return
      }
      commit(take())
      // A trailing commit is a commit: the next one is not due for another
      // full interval, so the window reopens instead of ending here.
      openWindow()
    }

    return {
      write(value) {
        latest = value
        deferred = true
        // Inside an open window every write does nothing but replace `latest`.
        if (timer !== null) return

        if (leading) commit(take())
        openWindow()
      },
      flush() {
        if (timer !== null) {
          clearTimeout(timer)
          timer = null
        }
        if (deferred) commit(take())
      },
      cancel() {
        if (timer !== null) {
          clearTimeout(timer)
          timer = null
        }
        deferred = false
        latest = undefined
      },
    }
  }
}

function assertDuration(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new TypeError(`${name} must be a finite, non-negative number of milliseconds`)
  }
}
