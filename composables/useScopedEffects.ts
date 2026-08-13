import { computed, effectScope, getCurrentScope, onScopeDispose, ref } from 'vue'
import type { ComputedRef, EffectScope } from 'vue'

export interface ScopedEffects {
  /**
   * Disposes the current group, then runs `setup` inside a fresh one. Every
   * effect `setup` creates — and any `onScopeDispose` cleanup it registers —
   * belongs to that group and dies with it.
   *
   * Returns whatever `setup` returned, so refs and computeds created inside
   * the group can be handed straight back to the caller.
   */
  run: <R>(setup: () => R) => R
  /** Disposes the current group. Idempotent; safe to call when nothing runs. */
  stop: () => void
  /** True while a group is alive. */
  isActive: ComputedRef<boolean>
  /** Increments on every {@link ScopedEffects.run}. `0` before the first. */
  generation: ComputedRef<number>
}

/**
 * A restartable group of effects whose lifetime is shorter than the
 * component's.
 *
 * `effectScope` is usually reached for to make effects live *longer* than a
 * component — see `createSharedComposable`. This is the other half: effects
 * that must be thrown away and rebuilt several times while one component stays
 * mounted. Watching a selected document, subscribing to a room, tailing a log
 * — switch the selection and the previous watchers are not just stale, they
 * are a leak, because a component scope only collects on unmount.
 *
 * The alternative is bookkeeping: keep every `stop` handle `watch` returns,
 * remember to call them all, and remember again when a new effect is added. A
 * scope replaces that with one handle for the whole group, and it collects
 * `onScopeDispose` cleanup for non-Vue resources at the same time.
 *
 * The inner scopes are detached (`effectScope(true)`) on purpose. A plain
 * `effectScope()` binds to whatever scope is active at creation time, and
 * `run` is typically called from an event handler or a watcher callback, where
 * that is either nothing or the wrong owner. Teardown is instead bound
 * explicitly to the scope that called this composable, so the group still dies
 * with its component.
 *
 * @example
 * ```ts
 * const selection = useScopedEffects()
 *
 * watch(documentId, (id) => {
 *   selection.run(() => {
 *     watch(() => draft.value, save)          // stops on the next switch
 *     const socket = subscribe(id)
 *     onScopeDispose(() => socket.close())    // and so does the socket
 *   })
 * })
 * ```
 */
export function useScopedEffects(): ScopedEffects {
  let scope: EffectScope | null = null
  const active = ref(false)
  const generation = ref(0)

  function stop(): void {
    if (scope === null) return
    const current = scope
    // Cleared first so an `onScopeDispose` callback that re-enters `run()`
    // during teardown cannot have its new scope stopped from under it.
    scope = null
    active.value = false
    current.stop()
  }

  function run<R>(setup: () => R): R {
    stop()

    const next = effectScope(true)
    // Adopted before `setup` runs, so a throwing `setup` still leaves its
    // half-built effects owned by this group instead of orphaning them.
    scope = next
    active.value = true
    generation.value += 1

    // `run` is typed `R | undefined` only because it skips the callback on a
    // stopped scope; `next` was created two statements ago.
    return next.run(setup) as R
  }

  // Bound to the caller's scope when there is one — a component, or another
  // scope in a nested composable. Without one (a bare unit test, a plugin) the
  // caller owns `stop()`.
  if (getCurrentScope()) {
    onScopeDispose(stop)
  }

  return {
    run,
    stop,
    isActive: computed(() => active.value),
    generation: computed(() => generation.value),
  }
}
