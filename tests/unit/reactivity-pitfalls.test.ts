import { describe, it, expect, vi } from 'vitest'
import {
  computed,
  isReactive,
  isRef,
  markRaw,
  nextTick,
  reactive,
  ref,
  shallowReactive,
  shallowRef,
  toRaw,
  toRef,
  toRefs,
  triggerRef,
  watch,
  watchSyncEffect,
} from 'vue'

/**
 * The executable half of `docs/reactivity-pitfalls.md`.
 *
 * Every claim that guide makes about Vue's behaviour is asserted here, so the
 * document cannot quietly go stale: if a Vue upgrade changes one of these
 * semantics, CI fails on the line that documents it rather than on a bug
 * report six months later. Tests are named for the claim they hold up and are
 * grouped under the guide's three headings.
 *
 * These exercise Vue itself rather than repo code, which is why they sit at
 * the root of `tests/unit/` next to `rendering-modes.test.ts` instead of
 * under `tests/unit/utils/`.
 *
 * `watchSyncEffect` is used throughout in place of `watch`: it runs
 * synchronously on every dependency change, so a test can count re-runs
 * without `await nextTick()` between each mutation and cannot accidentally
 * pass because two mutations were batched into one flush.
 */

/** Counts how many times an effect re-runs while reading `read()`. */
function trackRuns(read: () => unknown): { runs: () => number } {
  let runs = 0
  watchSyncEffect(() => {
    read()
    runs += 1
  })
  return { runs: () => runs }
}

// ─────────────────────────────────────────────────────────────────────────────
describe('destructuring loss', () => {
  it('destructuring a reactive object yields a dead copy', () => {
    const state = reactive({ count: 0, label: 'a' })
    const { count } = state

    state.count = 10

    // `count` was a `number` the instant it was bound. Nothing about it
    // remembers where it came from.
    expect(count).toBe(0)
    expect(state.count).toBe(10)
  })

  it('an effect reading a destructured copy never re-runs', () => {
    const state = reactive({ count: 0 })
    const { count } = state

    const dead = trackRuns(() => count)
    const live = trackRuns(() => state.count)

    state.count = 1
    state.count = 2

    expect(dead.runs()).toBe(1) // the initial run, and nothing after it
    expect(live.runs()).toBe(3)
  })

  it('toRefs keeps every property bound to the source', () => {
    const state = reactive({ count: 0 })
    const { count } = toRefs(state)

    const seen = trackRuns(() => count.value)

    state.count = 1
    expect(count.value).toBe(1)
    expect(seen.runs()).toBe(2)
  })

  it('refs from toRefs write back to the source', () => {
    const state = reactive({ count: 0 })
    const { count } = toRefs(state)

    count.value = 42

    // The ref is a two-way view, not a snapshot: this is what makes
    // `v-model="count"` on a destructured property work.
    expect(state.count).toBe(42)
  })

  it('rebinding a reactive variable orphans every existing reader', () => {
    let state = reactive({ n: 1 })
    const seen = trackRuns(() => state.n)

    // Assigning a new proxy changes only this binding. Effects captured the
    // *old* proxy as their dependency and will never hear from it again.
    state = reactive({ n: 2 })

    expect(state.n).toBe(2)
    expect(seen.runs()).toBe(1)
  })

  it('mutating in place, or holding the object in a ref, keeps readers attached', () => {
    const merged = reactive({ n: 1 })
    const mergedSeen = trackRuns(() => merged.n)
    Object.assign(merged, { n: 2 })
    expect(mergedSeen.runs()).toBe(2)

    const held = ref({ n: 1 })
    const heldSeen = trackRuns(() => held.value.n)
    held.value = { n: 2 } // whole-object replacement, still tracked
    expect(heldSeen.runs()).toBe(2)
  })

  it('reactive() silently declines primitives', () => {
    // Dev builds warn, production builds do not — either way you get the
    // primitive straight back, so `state.value = x` would be a runtime error
    // on a plain number.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const notReactive = reactive(1 as never)

    expect(notReactive as unknown).toBe(1)
    expect(isReactive(notReactive)).toBe(false)
    warn.mockRestore()
  })

  it('a ref stored on a reactive object is unwrapped, so writes go through it', () => {
    const inner = ref(0)
    const state = reactive({ inner })

    // Reading gives the value, not the ref — convenient in templates, and the
    // reason `state.inner.value` is a type error rather than the number.
    expect(isRef(state.inner)).toBe(false)
    expect(state.inner).toBe(0)

    state.inner = 5
    expect(inner.value).toBe(5) // the write reached the original ref
  })

  it('refs inside arrays and Maps are NOT unwrapped', () => {
    // The asymmetry that makes `list[0].value` correct and `state.x.value`
    // wrong in the same file.
    const list = reactive([ref(1)])
    const lookup = reactive(new Map([['k', ref(1)]]))

    expect(isRef(list[0])).toBe(true)
    expect(isRef(lookup.get('k'))).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('toRefs', () => {
  it('snapshots the key set at the moment it is called', () => {
    const state = reactive<{ a: number; b?: number }>({ a: 1 })
    const refs = toRefs(state)

    state.b = 2

    // `toRefs` walks the keys once. A property added afterwards has no ref,
    // which is why it is the wrong tool for a dictionary-shaped store.
    expect(Object.keys(refs)).toEqual(['a'])
    expect(refs.b).toBeUndefined()
  })

  it('toRef binds a key that does not exist yet', () => {
    const state = reactive<{ a: number; b?: number }>({ a: 1 })
    const b = toRef(state, 'b')

    expect(b.value).toBeUndefined()

    state.b = 5
    expect(b.value).toBe(5)

    b.value = 9
    expect(state.b).toBe(9) // and writing through it creates the key
  })

  it('toRefs on a ref-of-object does not work', () => {
    const state = ref({ a: 1 })

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // The signature accepts it, the runtime does not: a `Ref<object>` is not a
    // reactive proxy, so this warns and hands back the raw values.
    const refs = toRefs(state as never) as unknown as Record<string, unknown>
    expect(warn.mock.calls[0]?.[0]).toContain('toRefs() expects a reactive object')
    warn.mockRestore()

    expect(isRef(refs['a'])).toBe(false)
  })

  it('toRefs on a ref-of-object works once the object is reachable as a proxy', () => {
    const state = ref({ a: 1 })

    // `ref` deep-proxies its contents, so `state.value` *is* a reactive proxy
    // even though `state` is not. That is the one-character fix.
    const { a } = toRefs(state.value)

    state.value.a = 2
    expect(a.value).toBe(2)
  })

  it('toRef on a genuinely plain object reads through but tracks nothing', () => {
    const plain = { a: 1 }
    const a = toRef(plain, 'a')

    plain.a = 2

    // The value is live — it is a getter over the same object — but there is
    // no proxy underneath, so no effect can depend on it. The most misleading
    // case in this file: it looks correct in a `console.log` and never updates
    // a view.
    expect(a.value).toBe(2)
    const seen = trackRuns(() => a.value)
    plain.a = 3
    expect(seen.runs()).toBe(1)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('deep vs shallow', () => {
  it('ref() replaces nested objects with proxies, changing their identity', () => {
    const raw = { a: 1 }
    const held = ref(raw)

    expect(held.value).not.toBe(raw) // `===` against the original now fails
    expect(toRaw(held.value)).toBe(raw)
    expect(isReactive(held.value)).toBe(true)
  })

  it('shallowRef() and markRaw() both preserve identity', () => {
    const raw = { a: 1 }

    expect(shallowRef(raw).value).toBe(raw)

    const held = ref(markRaw({ b: 1 }))
    expect(isReactive(held.value)).toBe(false)
  })

  it('a shallowRef ignores mutation of the value it holds', () => {
    const rows = shallowRef([{ n: 0 }])
    const seen = trackRuns(() => rows.value.length)

    rows.value[0]!.n = 1 // nested write
    rows.value.push({ n: 2 }) // in-place write to the array itself
    expect(seen.runs()).toBe(1)

    triggerRef(rows) // publish the batch explicitly
    expect(seen.runs()).toBe(2)

    rows.value = [...rows.value] // or replace the whole value
    expect(seen.runs()).toBe(3)
  })

  it('a computed over a shallowRef goes stale, not just unnotified', () => {
    const source = shallowRef({ n: 1 })
    const doubled = computed(() => source.value.n * 2)

    expect(doubled.value).toBe(2)
    source.value.n = 5

    // The computed cached 2 and has no dependency that says otherwise, so it
    // is now wrong rather than merely late. Nothing recovers this except
    // `triggerRef` or a replacement value.
    expect(doubled.value).toBe(2)

    triggerRef(source)
    expect(doubled.value).toBe(10)
  })

  it('shallowReactive tracks the top level only', () => {
    const state = shallowReactive({ n: 0, nested: { n: 0 } })

    const top = trackRuns(() => state.n)
    const nested = trackRuns(() => state.nested.n)

    state.n = 1
    state.nested.n = 1

    expect(top.runs()).toBe(2)
    expect(nested.runs()).toBe(1)
    expect(isReactive(state.nested)).toBe(false)
  })

  it('watch on a reactive object is implicitly deep', async () => {
    const state = reactive({ nested: { n: 0 } })
    const changed = vi.fn()
    watch(state, changed)

    state.nested.n = 1
    await nextTick()

    expect(changed).toHaveBeenCalledTimes(1)
    // Both arguments are the same live proxy, so the "previous value" of a
    // deep watcher on a reactive object is not previous at all.
    const [next, previous] = changed.mock.calls[0]!
    expect(next).toBe(previous)
  })

  it('watch on a getter compares the result, so a nested mutation is invisible', async () => {
    const state = reactive({ nested: { n: 0 } })
    const changed = vi.fn()

    // The getter depends on `state.nested`, not on anything inside it. The
    // deeper write touches neither that dependency nor the identity of what
    // the getter returns.
    watch(() => state.nested, changed)

    state.nested.n = 1
    await nextTick()
    expect(changed).not.toHaveBeenCalled()

    state.nested = { n: 2 }
    await nextTick()
    expect(changed).toHaveBeenCalledTimes(1)
  })

  it('watch on a ref-of-object is not deep unless asked', async () => {
    const state = ref({ nested: { n: 0 } })
    const shallowWatch = vi.fn()
    const deepWatch = vi.fn()

    watch(state, shallowWatch)
    watch(state, deepWatch, { deep: true })

    state.value.nested.n = 1
    await nextTick()

    expect(shallowWatch).not.toHaveBeenCalled()
    expect(deepWatch).toHaveBeenCalledTimes(1)

    state.value = { nested: { n: 2 } }
    await nextTick()

    // Replacing `.value` notifies both — only *traversal* differs, not the
    // ref's own trigger.
    expect(shallowWatch).toHaveBeenCalledTimes(1)
    expect(deepWatch).toHaveBeenCalledTimes(2)
  })

  it('reactive arrays track length and out-of-range indices', () => {
    const list = reactive<number[]>([1, 2])
    const byLength = trackRuns(() => list.length)
    list.push(3)
    expect(byLength.runs()).toBe(2)

    const sparse = reactive<number[]>([1, 2])
    const byIndex = trackRuns(() => sparse[5])
    sparse[5] = 9
    expect(byIndex.runs()).toBe(2)
  })

  it('reactive collections track through their methods', () => {
    const lookup = reactive(new Map<string, number>())
    const seen = trackRuns(() => lookup.get('a'))

    lookup.set('a', 1)

    expect(seen.runs()).toBe(2)
  })
})
