import { ref } from 'vue'
import type { Ref } from 'vue'

/**
 * The parts of a Nuxt app that `useState` actually touches: a payload object
 * with a `state` bag on it. Nuxt creates one app per request on the server and
 * one per tab on the client, which is the whole reason `useState` is SSR-safe
 * and a module-scope `ref` is not.
 */
export interface FakeNuxtApp {
  payload: { state: Record<string, Ref<unknown>> }
}

export function createFakeNuxtApp(): FakeNuxtApp {
  return { payload: { state: {} } }
}

/**
 * The app the stubbed `useNuxtApp()` resolves to. In a real Nuxt process this
 * is async-local to the request being rendered; here it is a plain variable
 * that {@link withFakeNuxtApp} swaps, which is enough to model two requests
 * that must not see each other's state.
 */
let currentApp: FakeNuxtApp = createFakeNuxtApp()

export function useFakeNuxtApp(): FakeNuxtApp {
  return currentApp
}

/** Drops all state, as a fresh process would have. */
export function resetFakeNuxtApp(): FakeNuxtApp {
  currentApp = createFakeNuxtApp()
  return currentApp
}

/**
 * Runs `fn` as though `app` were the app being rendered, then restores whatever
 * was current before. Nesting is safe; the previous app is restored even if
 * `fn` throws.
 */
export function withFakeNuxtApp<T>(app: FakeNuxtApp, fn: () => T): T {
  const previous = currentApp
  currentApp = app
  try {
    return fn()
  } finally {
    currentApp = previous
  }
}

/**
 * Stand-in for Nuxt's `useState`, modelling the property that matters: the ref
 * is stored on the current app, so two apps calling the same key get two
 * independent refs, and the same app calling it twice gets the same one.
 *
 * Nuxt's own implementation additionally prefixes keys, hydrates from the
 * serialized payload, and warns on a missing initializer. None of that changes
 * where the state lives, which is what these tests are asserting about.
 */
export function fakeUseState<T>(key: string, init: () => T): Ref<T> {
  const state = useFakeNuxtApp().payload.state
  const existing = state[key]
  if (existing !== undefined) return existing as Ref<T>

  const created = ref(init()) as Ref<T>
  state[key] = created as Ref<unknown>
  return created
}
