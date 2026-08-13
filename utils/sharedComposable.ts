import { effectScope, getCurrentScope, onScopeDispose } from 'vue'
import type { EffectScope } from 'vue'

/**
 * One live instance of a shared composable: the scope that owns every effect
 * the factory created, the value it returned, and how many scopes are still
 * holding on to it.
 */
interface Instance<T> {
  scope: EffectScope
  value: T
  consumers: number
}

export interface SharedComposable<T> {
  /**
   * Returns the shared value, running the factory on first use.
   *
   * Called from inside a component `setup()` — or any other active effect
   * scope — it also takes out a subscription that is released automatically
   * when that scope is disposed. Called with no active scope (a route
   * middleware, a plugin, a bare unit test) it still returns the shared value
   * but takes out no subscription, so the instance stays alive until
   * {@link SharedComposable.dispose} is called.
   */
  (): T
  /** How many scopes currently hold a subscription. `0` when torn down. */
  consumers: () => number
  /** True while an instance exists. */
  isActive: () => boolean
  /**
   * Tears the instance down now, regardless of subscribers. The next call
   * builds a fresh one. Subscriptions taken out against the old instance
   * become inert rather than dangerous — they can no longer tear down its
   * replacement.
   */
  dispose: () => void
}

/**
 * Turns a composable into a singleton whose state is created once, shared by
 * every caller, and torn down as a group when the last caller goes away.
 *
 * The problem it solves is ownership. Effects — `watch`, `watchEffect`,
 * `computed` — register on whatever scope is active when they are created, and
 * a component's scope is disposed on unmount. So the usual "shared composable"
 * written as a module-level `ref` plus a `watch` created on first use is
 * quietly wrong twice over: the watcher belongs to whichever component
 * happened to mount first and dies when *that* component unmounts, even though
 * other components are still reading the state; and nothing ever releases it
 * when they all leave, so intervals and subscriptions leak for the life of the
 * page.
 *
 * `effectScope(true)` — detached, so it attaches to no parent — gives the
 * factory a scope of its own. Everything it creates belongs to that scope, and
 * one `stop()` collects all of it, including any `onScopeDispose` cleanup the
 * factory registered for non-Vue resources like a socket or an interval.
 *
 * Reference counting decides when that `stop()` happens: each caller with an
 * active scope registers an `onScopeDispose` on *its own* scope, and the last
 * one out disposes the instance. A later call builds a new one, so the pattern
 * is lazy on both edges — nothing is created before the first consumer, and
 * nothing survives the last.
 *
 * **SSR.** The instance is per-process, not per-request, so anything created
 * during SSR is shared by every request that touches it afterwards. Subscribe
 * from the client only — an event handler, a `<ClientOnly>` boundary, an
 * `import.meta.client` guard — or keep the shared value free of per-user data.
 * State that must be per-request and survive hydration is what Nuxt's
 * `useState` is for; this is for client-side resources with a lifetime longer
 * than any one component.
 *
 * @example
 * ```ts
 * // composables/useSessionClock.ts
 * export const useSessionClock = createSharedComposable(() => {
 *   const now = ref(Date.now())
 *   const id = setInterval(() => (now.value = Date.now()), 1_000)
 *   // Runs when the last consumer unmounts, not when the first one does.
 *   onScopeDispose(() => clearInterval(id))
 *   return { now: readonly(now) }
 * })
 * ```
 *
 * @param factory Builds the shared value. Runs inside the detached scope, so
 *   any effect or `onScopeDispose` cleanup it registers is owned by the group.
 */
export function createSharedComposable<T>(factory: () => T): SharedComposable<T> {
  let instance: Instance<T> | null = null

  /**
   * Stops `target` if it is still the current instance. The guard is what
   * makes stale subscriptions harmless: a consumer that outlives an explicit
   * `dispose()` will still run its release callback, and without this check it
   * would tear down whichever instance had replaced it.
   */
  function teardown(target: Instance<T>): void {
    if (instance !== target) return
    instance = null
    target.scope.stop()
  }

  function use(): T {
    if (instance === null) {
      const scope = effectScope(true)
      // `run` is typed `T | undefined` because it skips the callback on a
      // stopped scope. This one was created on the line above.
      const value = scope.run(factory) as T
      instance = { scope, value, consumers: 0 }
    }

    // Captured, not re-read: the release callback below must always act on the
    // instance this call subscribed to.
    const current = instance

    // No active scope means nothing will ever tell us this caller has gone, so
    // counting it would pin the instance open forever. `onScopeDispose` would
    // also warn. Hand back the value and stay out of the refcount.
    if (getCurrentScope()) {
      current.consumers += 1
      onScopeDispose(() => {
        current.consumers -= 1
        if (current.consumers === 0) teardown(current)
      })
    }

    return current.value
  }

  return Object.assign(use, {
    consumers: (): number => instance?.consumers ?? 0,
    isActive: (): boolean => instance !== null,
    dispose: (): void => {
      if (instance !== null) teardown(instance)
    },
  })
}
