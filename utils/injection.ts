import { getCurrentInstance, hasInjectionContext, inject, provide } from 'vue'
import type { App, InjectionKey } from 'vue'

/**
 * Thrown by {@link Injection.inject} when nothing up the tree provided a value.
 *
 * Vue's own failure mode is a `console.warn` and an `undefined` return, which
 * surfaces later as a `TypeError` in whichever line first touched the missing
 * dependency — usually somewhere that has nothing to do with the provider that
 * was forgotten. This throws at the injection site instead, naming the key.
 */
export class InjectionNotProvidedError extends Error {
  /** The description the injection was defined with, e.g. `'todos.gateway'`. */
  readonly injectionName: string

  constructor(injectionName: string, reason: string) {
    super(`[injection] "${injectionName}" ${reason}`)
    this.name = 'InjectionNotProvidedError'
    this.injectionName = injectionName
  }
}

/**
 * A provide/inject pair bound to one `InjectionKey<T>`.
 *
 * Every method is a thin wrapper over Vue's `provide`/`inject` with the key
 * already applied, so a caller never names the key and never restates `T`.
 */
export interface Injection<T> {
  /**
   * The key itself, for the places a wrapper cannot reach: `app.provide()` in a
   * plugin, `app.runWithContext()` in a test, or a `provide` option in a
   * non-`<script setup>` component.
   */
  readonly key: InjectionKey<T>
  /** The human-readable name used in error messages. */
  readonly name: string
  /**
   * Provides `value` to this component's descendants. Must be called
   * synchronously in `setup()`, like Vue's `provide`.
   */
  provide: (value: T) => void
  /**
   * Provides `value` to an entire app — every component in it, plus anything
   * run inside `app.runWithContext()`. This is the Nuxt-plugin entry point:
   * `nuxtApp.vueApp` is the app for exactly one request on the server and one
   * tab on the client, so an app-level provide is per-request, not per-process.
   */
  provideTo: (app: App, value: T) => void
  /**
   * Returns the provided value, or throws {@link InjectionNotProvidedError}.
   *
   * The throw is the point. `InjectionKey<T>` types the value but not its
   * absence: `inject(key)` is `T | undefined` for a dependency that is
   * mandatory in every real render, which is why the pattern degenerates into
   * `inject(key)!` and hands back a non-null type for a value that can be
   * missing. Failing loudly at the injection site keeps the type honest and
   * points at the component that should have provided it.
   */
  inject: () => T
  /** Returns the provided value, or `fallback` when there is none. */
  injectOr: <F>(fallback: F) => T | F
  /** Returns the provided value, or `undefined` — Vue's own semantics. */
  injectOptional: () => T | undefined
  /** True when an ancestor (or the app) provided a value. */
  isProvided: () => boolean
}

/**
 * A value no caller can produce, used as the "nothing was provided" signal.
 *
 * `inject(key)` returns `undefined` both when nothing was provided and when
 * `undefined` *was* — so `undefined` cannot distinguish the two. A private
 * symbol can, which is what lets {@link Injection.isProvided} and
 * {@link Injection.injectOr} behave correctly for a nullable `T`.
 */
const MISSING: unique symbol = Symbol('injection.missing')

/**
 * Defines a typed provide/inject contract.
 *
 * ### Why a key object rather than a string
 *
 * `provide('gateway', value)` and `inject('gateway')` compile against any two
 * unrelated types — the string carries no type at all, so `inject` returns
 * `unknown` and every call site asserts. `InjectionKey<T>` is a `Symbol` with a
 * phantom `T` on it, so a single declaration types both ends: `provide` rejects
 * the wrong value and `inject` needs no annotation. Symbols also cannot
 * collide, which strings silently do — two libraries that both pick `'store'`
 * shadow each other with no diagnostic.
 *
 * `Symbol()`, not `Symbol.for()`: the latter interns into a process-wide
 * registry, which on the server is shared by every request the process serves
 * and by every module that guesses the same string.
 *
 * ### When to reach for this at all
 *
 * `provide`/`inject` is for a dependency an entire subtree shares and no
 * intermediate component should have to know about. Passing it as a prop
 * through four layers that only forward it is the smell; injection is the fix.
 * It is *not* a general state container — for that, this repo has Pinia stores
 * and `useState`, both of which are per-app in the same way. What injection
 * adds is that the *implementation* is chosen by an ancestor, so the consumer
 * depends on an interface it does not construct. See
 * [`docs/provide-inject.md`](../docs/provide-inject.md).
 *
 * ### SSR
 *
 * Provided values live on the component instance (or the app), never on the
 * module, so they are per-request on the server by construction. That is the
 * property that makes injection the right way to publish a request-scoped
 * dependency — a module-scope singleton is shared by every visitor the process
 * serves, and a value provided in a plugin is not.
 *
 * @example
 * ```ts
 * // utils/todoGateway.ts
 * export const todoGatewayInjection = defineInjection<TodoGateway>('todos.gateway')
 *
 * // an ancestor component, or a plugin via provideTo(nuxtApp.vueApp, …)
 * todoGatewayInjection.provide(createHttpTodoGateway())
 *
 * // any descendant, at any depth, with no props threaded through
 * const gateway = todoGatewayInjection.inject()
 * ```
 *
 * @param name Identifies the injection in error messages and devtools. Namespace
 *   it (`'todos.gateway'`) so two contracts are told apart at a glance.
 */
export function defineInjection<T>(name: string): Injection<T> {
  const key: InjectionKey<T> = Symbol(name)

  /**
   * The one place `inject` is called. Returns {@link MISSING} rather than
   * `undefined` for "not provided", so every public method below can tell an
   * absent value from a provided `undefined`.
   *
   * The `hasInjectionContext()` guard exists because Vue resolves injections
   * from whatever instance is current, and outside `setup()` — an event
   * handler, a `setTimeout`, anything after an `await` — there is none. Vue
   * warns and returns the default; the value looks merely missing when it is
   * really being asked for in the wrong place, so the two are reported
   * separately.
   */
  function read(): T | typeof MISSING {
    if (!hasInjectionContext()) {
      throw new InjectionNotProvidedError(
        name,
        'was injected outside of a setup() or app context. Injections resolve ' +
          'against the component being set up, so call this synchronously in ' +
          'setup() — before any await — and keep the result, or run it inside ' +
          'app.runWithContext().',
      )
    }

    // `MISSING` is not assignable to `T`, and the third argument (treat the
    // default as a factory) is left false so a function-typed `T` is never
    // called on the way out.
    return inject(key, MISSING as unknown as T, false) as T | typeof MISSING
  }

  return {
    key,
    name,

    provide(value: T): void {
      // A provide outside setup() lands on nothing at all — Vue warns and drops
      // it — and the symptom is a missing injection in a child, one layer away
      // from the cause.
      if (getCurrentInstance() === null) {
        throw new InjectionNotProvidedError(
          name,
          'was provided outside of a component setup(). Call provide() ' +
            'synchronously in setup(), or use provideTo(app, value) for an ' +
            'app-wide dependency.',
        )
      }
      provide(key, value)
    },

    provideTo(app: App, value: T): void {
      app.provide(key, value)
    },

    inject(): T {
      const value = read()
      if (value === MISSING) {
        throw new InjectionNotProvidedError(
          name,
          'was not provided by any ancestor. Provide it in a parent component ' +
            "setup() with this injection's provide(), or app-wide from a Nuxt " +
            'plugin with provideTo(nuxtApp.vueApp, value).',
        )
      }
      return value
    },

    injectOr<F>(fallback: F): T | F {
      const value = read()
      return value === MISSING ? fallback : value
    },

    injectOptional(): T | undefined {
      const value = read()
      return value === MISSING ? undefined : value
    },

    isProvided(): boolean {
      return read() !== MISSING
    },
  }
}
