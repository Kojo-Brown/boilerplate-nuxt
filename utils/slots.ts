/**
 * Passing a component's slots through to a child it renders.
 *
 * A wrapper component that adds chrome around another component — a card, a
 * section heading, a permission check — has a slot problem the component it
 * wraps does not: it has to accept every slot its child accepts, forward them
 * untouched, and keep doing so when the child grows a new one. Written out by
 * hand that is a `<template #name>` per slot, restated in the wrapper, and a
 * wrapper that silently swallows any slot nobody remembered to list.
 *
 * A render function forwards the whole set in one expression instead, because
 * slots are just an object of functions there.
 */

/** Which slot names {@link forwardSlots} passes on. */
export interface ForwardSlotsOptions {
  /** Forward only these names. Omit to forward everything. */
  readonly only?: readonly string[]
  /** Names the wrapper renders itself and must not pass on. */
  readonly except?: readonly string[]
}

/**
 * True for the bookkeeping Vue keeps on a slots object rather than a slot.
 *
 * `_` and the keys beginning with it (`_ctx`, and the compiled-slots marker
 * itself) plus `$stable` are Vue's, and forwarding them would be a lie about
 * an object that is not the one they describe: `_` claims the slots were
 * compiled together and can skip normalization, and `$stable` promises the
 * child that it need not re-render when the parent does. Both would be applied
 * to a *different* object than the one they were computed for. Vue skips these
 * same names when it normalizes raw slots, so dropping them here costs nothing
 * and keeps the forwarded object honest.
 */
function isInternalSlotKey(key: string): boolean {
  return key.startsWith('_') || key === '$stable'
}

/**
 * A live, filtered view of `slots`, suitable for passing straight to `h()`.
 *
 * ## Why a proxy and not a copy
 *
 * `{ ...slots }` is the obvious implementation and it is wrong in a way that
 * only shows up later. `ctx.slots` is not a snapshot the parent hands over
 * once — Vue replaces its *contents* on every update, and a parent whose slot
 * is behind a `v-if` adds and removes the key as it renders. A spread taken in
 * `setup()` captures the key set as it was at first render, so a slot the
 * parent starts passing on the second render never reaches the child, and one
 * it stops passing keeps rendering the stale function. A proxy reads through
 * on every access, so the forwarded object is correct from `setup()` as well as
 * from inside a render function.
 *
 * The proxy's own target is not empty for long: Vue writes `_ctx` onto a raw
 * slots object to record which instance owns the slot functions. Those writes
 * land on the target and read back from it, so the ownership Vue depends on
 * survives the forward — while `ownKeys` still reports only real slot names, so
 * nothing internal is ever mistaken for a slot.
 *
 * ## Typing
 *
 * The return type is the argument's type. `except` removes names at runtime,
 * which does not narrow the type — but every slot name is optional in a slots
 * type (a component cannot require that a parent pass a slot), so an object
 * with fewer of them still satisfies it. What the types do guarantee is the
 * direction: a wrapper can only forward to a child whose slots are a superset
 * of its own.
 */
export function forwardSlots<Slots extends object>(
  slots: Slots,
  options: ForwardSlotsOptions = {},
): Slots {
  const only = options.only === undefined ? null : new Set(options.only)
  const except = new Set(options.except ?? [])
  const source = slots as Record<string, unknown>

  function isForwarded(key: string | symbol): key is string {
    return (
      typeof key === 'string' &&
      !isInternalSlotKey(key) &&
      !except.has(key) &&
      (only === null || only.has(key))
    )
  }

  // The target is a real object with no own properties, which is what makes the
  // traps below legal: a proxy may only hide or invent properties when the
  // target does not already commit to them.
  return new Proxy({} as Slots, {
    get: (target, key) => (isForwarded(key) ? source[key] : Reflect.get(target, key)),
    set: (target, key, value) => Reflect.set(target, key, value),
    has: (target, key) => (isForwarded(key) ? key in source : Reflect.has(target, key)),
    ownKeys: () => Reflect.ownKeys(source).filter(isForwarded),
    getOwnPropertyDescriptor: (target, key) =>
      isForwarded(key) && key in source
        ? { value: source[key], enumerable: true, configurable: true, writable: false }
        : Reflect.getOwnPropertyDescriptor(target, key),
  })
}
