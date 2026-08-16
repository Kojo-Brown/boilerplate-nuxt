# Reactivity Pitfalls

Vue's reactivity is invisible at the call site. `count` is a `number` whether it
came off a live proxy or off a destructure that severed it three lines earlier;
`state` is an object whether it is a `reactive` proxy or the raw literal someone
forgot to wrap. Nothing throws when the connection is lost — the view simply
renders once and then stops, far from the line that caused it.

This is the failure mode behind most "why isn't it updating?" bugs, and it comes
in three flavours: a binding that was severed (**destructuring loss**), a fix
applied with the wrong tool (**`toRefs` vs `toRef`**), and reactivity that was
deliberately made shallow and then read as if it were deep (**deep vs shallow**).

Every claim below is asserted in
[`tests/unit/reactivity-pitfalls.test.ts`](../tests/unit/reactivity-pitfalls.test.ts),
so a Vue upgrade that changes one of these semantics fails CI on the test that
documents it. Live demo: `/reactivity-pitfalls`.

---

## Destructuring loss

### Destructuring a `reactive` object copies values out of it

```ts
const state = reactive({ count: 0 })
const { count } = state // a plain `number`, bound once

state.count = 10
count // still 0
```

The proxy's `get` trap runs during the destructure, returns `0`, and that is the
end of it. `count` is not a stale reference to something — it is a number.
Effects that read it never re-run, because reading a number registers no
dependency.

**Fix:** `toRefs` for the whole object, `toRef` for one property.

```ts
const { count } = toRefs(state)
count.value // tracked, and writing it writes back to `state.count`
```

### Reassigning the variable orphans every existing reader

```ts
let state = reactive({ n: 1 })
watchEffect(() => console.log(state.n))

state = reactive({ n: 2 }) // the effect never fires again
```

The effect captured the _first_ proxy as its dependency. Rebinding the local
variable is invisible to it.

**Fix:** mutate in place with `Object.assign(state, next)`, or hold the object
in a `ref` and replace `.value` — that write goes through the ref, which every
reader depends on.

### `reactive()` declines primitives

`reactive(1)` warns in dev and returns `1`. There is no proxy, so `state.value`
is a runtime error and nothing is tracked. Production builds skip the warning,
so this can reach a deploy silently. Primitives belong in a `ref`.

### Refs unwrap as object properties — but not inside arrays or Maps

```ts
const inner = ref(0)

const state = reactive({ inner })
state.inner // 0, not a Ref — and `state.inner = 5` writes through to `inner`

const list = reactive([ref(1)])
list[0] // still a Ref — `.value` required
```

The same file can correctly contain both `state.x` and `list[0].value`. Vue only
unwraps refs found at the top level of a plain-object reactive proxy.

### Assert at the boundary

A composable that needs live state cannot tell it was handed a corpse. State the
requirement instead of discovering it later:

```ts
import { assertTracked } from '~/utils/reactivityInspect'

export function useFilters(state: Reactive<Filters>) {
  assertTracked(state, 'useFilters(state)')
  // …
}
```

For diagnosis rather than enforcement, `describeReactivity()` and
`formatReactivity()` from the same module classify any value — `'reactive
(deep)'`, `'shallowRef'`, `'plain (not tracked)'` — without reading through it,
so calling them inside an effect adds no dependency.

---

## `toRefs` vs `toRef`

`toRefs` walks the source's keys **once**, at call time.

```ts
const state = reactive<{ a: number; b?: number }>({ a: 1 })
const refs = toRefs(state)

state.b = 2
refs.b // undefined — the key did not exist when toRefs ran
```

So `toRefs` is right for a fixed-shape object (a form model, a composable's
return value) and wrong for anything dictionary-shaped whose keys arrive later.

`toRef(source, key)` binds the key rather than its current value, and works
before the key exists:

```ts
const b = toRef(state, 'b')
b.value // undefined
state.b = 5
b.value // 5
b.value = 9 // creates the key on `state`
```

### `toRefs` does not accept a `Ref<object>`

```ts
const state = ref({ a: 1 })
toRefs(state) // ⚠️ "toRefs() expects a reactive object" — returns raw values
```

`ref` deep-proxies its contents, so the proxy you want is one level in:

```ts
const { a } = toRefs(state.value) // works
```

### `toRef` on a genuinely plain object is the trap worth remembering

```ts
const plain = { a: 1 } // no reactive() anywhere
const a = toRef(plain, 'a')

plain.a = 2
a.value // 2 — reads through, because it is a getter over the same object
```

The value is live, so this looks correct in a `console.log` and in a debugger.
But there is no proxy underneath, so no effect can depend on it, and the view
never updates. `toRef` makes a _ref-shaped view_; it cannot make a plain object
reactive.

### Destructuring what a composable returns

Returning `toRefs(state)` is what lets callers destructure safely — and the
convention this repo follows for composables that hold an object of state:

```ts
function useFilters() {
  const state = reactive({ query: '', page: 1 })
  return { ...toRefs(state), reset: () => Object.assign(state, { query: '', page: 1 }) }
}

const { query, page } = useFilters() // both live
```

One exception: properties hung _on_ a ref rather than inside it — the way
`DeferredRef` exposes `pending` and `flush` — must be destructured in
`<script setup>` and not reached through the ref in a template, because a
top-level ref is auto-unwrapped there. See [Deferred Refs](../README.md#deferred-refs).

---

## Deep vs shallow

`ref` and `reactive` are deep: every nested object is replaced by its own proxy
on first access. That buys "mutate anything, everything updates" and costs a
proxy per object, a traversal per deep `watch`, and object identity.

### Deep reactivity changes identity

```ts
const raw = { a: 1 }
const held = ref(raw)

held.value === raw // false — it is a proxy of `raw`
toRaw(held.value) === raw // true
```

Anything that compares by reference — a `Map` keyed on the object, a
`WeakMap` cache, a third-party instance that checks its own internals — breaks
against a deep proxy. `shallowRef` preserves identity, and `markRaw(obj)` opts
one object out of proxying wherever it ends up.

### Shallow means the value is a black box

```ts
const rows = shallowRef([{ n: 0 }])

rows.value[0].n = 1 // no notification
rows.value.push({ n: 2 }) // no notification — in-place is still in-place
triggerRef(rows) // publish the batch
rows.value = [...rows.value] // or replace the value
```

This is not just "notified late". A `computed` over a shallow source **caches a
wrong answer**:

```ts
const source = shallowRef({ n: 1 })
const doubled = computed(() => source.value.n * 2) // 2

source.value.n = 5
doubled.value // still 2 — cached, with no dependency to invalidate it
```

Nothing recovers that except `triggerRef` or a replacement value. That is the
real cost of shallow: correctness moves from the framework to you. Take it
deliberately, for large payloads where the proxy overhead is measured — see
`useLargeCollection` and `/reactivity-performance` — not as a default.

`shallowReactive` is the same trade one level in: top-level keys are tracked,
`state.nested` is a raw object, and `isReactive(state.nested)` is `false`.

### `watch` depth differs by source, and it is not obvious

| Source                  | Nested mutation fires the watcher?   |
| ----------------------- | ------------------------------------ |
| `watch(reactiveObject)` | **yes** — implicitly deep            |
| `watch(refOfObject)`    | no — add `{ deep: true }`            |
| `watch(() => state.x)`  | no — getter result compared by `===` |

Watching a `reactive` object is the surprising one: it traverses the whole
object on every change, and both callback arguments are the same live proxy, so
the "previous value" is not previous.

```ts
watch(state, (next, previous) => {
  next === previous // true
})
```

If you need the old value, watch a getter that returns a primitive
(`watch(() => state.count, …)`) or a snapshot
(`watch(() => ({ ...state }), …, { deep: true })`).

### Choosing

| Want                                                  | Use                         |
| ----------------------------------------------------- | --------------------------- |
| A primitive, or an object you replace wholesale       | `ref`                       |
| An object you mutate field by field                   | `reactive`                  |
| A large payload you replace, or identity preservation | `shallowRef` + `triggerRef` |
| A container whose top-level keys change, cheap values | `shallowReactive`           |
| A third-party instance that must not be proxied       | `markRaw`                   |

When you are unsure what you actually built, `formatReactivity(value)` will tell
you.
