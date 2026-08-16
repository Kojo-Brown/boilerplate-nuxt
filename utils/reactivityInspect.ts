import { isReactive, isReadonly, isRef, isShallow } from 'vue'

/**
 * What Vue's public predicates can actually tell you about a value.
 *
 * The nine kinds are the complete partition of `isRef` × `isReactive` ×
 * `isReadonly` × `isShallow` that Vue can produce — every combination outside
 * this list is unreachable. Deliberately coarser than the API surface in two
 * places, because the public predicates genuinely cannot see the difference:
 *
 * - `'ref'` also covers a writable `computed` and any `customRef`. All three
 *   are `isRef` and nothing else, so a diagnostic that claimed to distinguish
 *   them would be reading internals.
 * - `'readonlyRef'` covers a read-only `computed` and `readonly(ref(x))`
 *   alike. `isProxy` happens to separate them today, but only as a side effect
 *   of how `ComputedRefImpl` carries its flags, so this does not rely on it.
 */
export type ReactivityKind =
  | 'ref'
  | 'shallowRef'
  | 'readonlyRef'
  | 'reactive'
  | 'shallowReactive'
  | 'readonlyReactive'
  | 'readonly'
  | 'shallowReadonly'
  | 'plain'

export interface ReactivityDescriptor {
  /** @see ReactivityKind */
  kind: ReactivityKind
  /**
   * False only for `'plain'`: reads of this value register no dependency, so
   * nothing downstream will ever re-run because of it. This is the flag that
   * catches a value flattened by destructuring.
   */
  tracked: boolean
  /** Reactivity stops at the first level — `shallowRef`, `shallowReactive`, `shallowReadonly`. */
  shallow: boolean
  /** Writes are rejected (and warn in dev) — `readonly`, `shallowReadonly`, read-only `computed`. */
  readonly: boolean
  /**
   * Nested property access through this value is tracked too, so mutating
   * something several levels down notifies readers. True for every tracked,
   * non-shallow kind; vacuously true for a deep ref that happens to hold a
   * primitive, since there is nothing nested to reach.
   */
  deep: boolean
}

/**
 * Classifies how — and how deeply — a value participates in reactivity.
 *
 * Reactivity is invisible at the call site. `count` is a `number` whether it
 * came from `state.count` on a live proxy or from a destructure that severed
 * it three lines earlier, and `state` is an object whether it is a `reactive`
 * proxy or the raw literal someone forgot to wrap. The failure that follows —
 * a view that renders once and then never updates — shows up far from the line
 * that caused it. This turns the question into an answer you can log, assert
 * on, or render.
 *
 * **Never reads through the value.** `.value` is not touched and no property
 * is accessed, so calling this inside a `computed` or a `watchEffect` adds no
 * dependency. A diagnostic that changed which effects re-run would be worse
 * than no diagnostic.
 *
 * @example
 * ```ts
 * const state = reactive({ count: 0 })
 * describeReactivity(state).kind          // 'reactive'
 * describeReactivity(state.count).tracked // false — a plain number
 * describeReactivity(toRef(state, 'count')).kind // 'ref'
 * ```
 */
export function describeReactivity(value: unknown): ReactivityDescriptor {
  const shallow = isShallow(value)
  const readonly = isReadonly(value)
  const kind = classify(value, shallow, readonly)

  return {
    kind,
    tracked: kind !== 'plain',
    shallow,
    readonly,
    deep: kind !== 'plain' && !shallow,
  }
}

function classify(value: unknown, shallow: boolean, readonly: boolean): ReactivityKind {
  // Order matters: a ref is never a reactive proxy, but `readonly(reactive(x))`
  // is both reactive and readonly, and `readonly(ref(x))` is both a ref and
  // readonly. Checking the container first and its modifiers second keeps
  // those from being reported as bare `'readonly'`.
  if (isRef(value)) {
    if (shallow) return 'shallowRef'
    return readonly ? 'readonlyRef' : 'ref'
  }

  if (isReactive(value)) {
    if (shallow) return 'shallowReactive'
    return readonly ? 'readonlyReactive' : 'reactive'
  }

  if (readonly) return shallow ? 'shallowReadonly' : 'readonly'

  return 'plain'
}

/**
 * A one-line rendering of {@link describeReactivity}, for logs and for the
 * `/reactivity-pitfalls` demo.
 *
 * The modifiers are the ones the kind does not already imply: `'shallowRef'`
 * says shallow in its name, so only `'not tracked'`, `'deep'`, and
 * `'read-only'` are worth adding.
 *
 * @example
 * ```ts
 * formatReactivity(reactive({ a: 1 })) // 'reactive (deep)'
 * formatReactivity(shallowRef([]))     // 'shallowRef'
 * formatReactivity(42)                 // 'plain (not tracked)'
 * ```
 */
export function formatReactivity(value: unknown): string {
  const { kind, tracked, readonly, deep } = describeReactivity(value)

  // `shallow` is never listed: every shallow kind is named for it.
  const notes: string[] = []
  if (!tracked) notes.push('not tracked')
  // Redundant with the kind for anyone who knows the API, but it is exactly
  // what a reader comparing two lines of this output is looking for.
  if (deep) notes.push('deep')
  // Skipped where the name already says it — 'readonly (read-only)' is noise.
  if (readonly && kind !== 'readonly' && kind !== 'shallowReadonly') notes.push('read-only')

  return notes.length > 0 ? `${kind} (${notes.join(', ')})` : kind
}

/**
 * Throws unless `value` is tracked by Vue.
 *
 * For the boundary of a composable or helper that only works on live state:
 * `useFilters(state)` cannot function if the caller destructured `state` on
 * the way in, but nothing about the resulting `number` says so, and the bug
 * surfaces later as a view that stopped updating. Asserting at the boundary
 * moves the failure to the call site that caused it.
 *
 * Deliberately unconditional rather than gated behind `import.meta.dev`. It is
 * cheap — three predicate calls, no traversal — and a composable handed dead
 * state is broken in production too; failing there with a legible message
 * beats rendering stale data.
 *
 * @param label How the value is named at the call site, so the message can
 *   point at it: `assertTracked(state, 'useFilters(state)')`.
 * @throws {TypeError} When `value` is neither a ref nor a reactive proxy.
 */
export function assertTracked(value: unknown, label: string): void {
  const { kind } = describeReactivity(value)
  if (kind !== 'plain') return

  throw new TypeError(
    `${label} must be a ref or a reactive object, but it is not tracked ` +
      `(${describeValue(value)}). A value destructured off a reactive object ` +
      `is a plain copy — pass the source, or use toRef()/toRefs() to keep the ` +
      `binding live.`,
  )
}

/** `typeof` is useless for `null` and for objects; this says which one it was. */
function describeValue(value: unknown): string {
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  if (Array.isArray(value)) return 'a plain array'
  if (typeof value === 'object') return 'a plain object'
  return `a ${typeof value}`
}
