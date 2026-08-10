import { computed, markRaw, reactive, shallowRef, triggerRef } from 'vue'
import type { ComputedRef, ShallowRef } from 'vue'

/**
 * Derives the stable identity of a row. Called once per row on every reindex,
 * so it must be cheap and pure.
 */
export type ItemKey<T> = (item: T) => string

export interface LargeCollectionOptions<T> {
  /** Stable identity for each row; backs the O(1) lookup index. */
  key: ItemKey<T>
  /** Rows to seed the collection with. Copied, never aliased. */
  initial?: readonly T[] | undefined
}

export interface LargeCollection<T extends object> {
  /**
   * The rows themselves. A `shallowRef`, so the rows are plain objects — not
   * reactive proxies. Reading `items.value[i].name` in a template tracks
   * `items` and nothing else.
   *
   * Typed `readonly T[]` because every write goes through a method below;
   * pushing straight onto `items.value` would mutate the array without
   * updating the index or firing effects.
   */
  items: ShallowRef<readonly T[]>
  /** Row count. Recomputes on commit, including after in-place mutation. */
  size: ComputedRef<number>
  /**
   * Increments once per commit. Bind to it when you need a dependency that is
   * cheaper than the row array itself — a `:key` on a virtualised list, say.
   */
  revision: ComputedRef<number>
  /**
   * The lookup index, exposed read-only for iteration and key checks. It is
   * `markRaw`-ed, so reading from it never registers a reactive dependency —
   * see the `markRaw` note below. Rebuilt in place, so the reference is stable.
   */
  index: ReadonlyMap<string, T>
  /** O(1) lookup by key. Returns the live row object, not a copy. */
  find: (key: string) => T | undefined
  /** Swap the whole payload. One shallow write; no row is walked. */
  replaceAll: (rows: readonly T[]) => void
  /** Append without reallocating the existing array. */
  append: (rows: readonly T[]) => void
  /**
   * Mutate rows in place and commit exactly once. The array handed to the
   * mutator is the live one — reorder it, splice it, edit rows directly.
   */
  mutate: (mutator: (rows: T[]) => void) => void
  /** Patch one row in place. Returns false if the key is unknown. */
  patch: (key: string, patch: Partial<T>) => boolean
  /** Remove one row. Returns false if the key is unknown. */
  remove: (key: string) => boolean
  /** Drop every row. */
  clear: () => void
}

/**
 * A collection built for payloads large enough that reactivity itself is the
 * bottleneck — tens of thousands of rows from an export, a log tail, a table.
 *
 * Three Vue primitives carry the design:
 *
 * - **`shallowRef`** holds the rows. `ref([...])` deep-walks the array on write
 *   and installs a Proxy per row and per nested object; at 20k rows that is 20k+
 *   proxies allocated before a single pixel is painted, and every property read
 *   during render goes through a trap. `shallowRef` tracks one thing: whether
 *   `.value` was reassigned.
 *
 * - **`triggerRef`** is what makes in-place edits usable. Because the rows are
 *   not proxied, mutating one is invisible to the renderer. Rather than pay for
 *   a fresh array on every keystroke, mutate and then commit — one explicit
 *   invalidation for a batch of any size.
 *
 * - **`markRaw`** protects the lookup index. It lives on a `reactive` metadata
 *   object next to `revision`, and `reactive` deep-converts what it holds: an
 *   unmarked `Map` would become a collection proxy that tracks a dependency on
 *   every `get()` and fires effects on every `set()`. Nothing renders the index,
 *   so all of that is overhead. `markRaw` opts it out permanently.
 *
 * The trade is explicit: you give up automatic deep tracking and take on
 * calling the mutators. In exchange, updating a 50k-row table costs one
 * invalidation instead of 50k proxy installations.
 *
 * ```ts
 * const rows = useLargeCollection<LogRow>({ key: (r) => r.id })
 * rows.replaceAll(await $fetch('/api/logs'))
 * rows.patch('log-42', { level: 'error' }) // in place, one commit
 * ```
 *
 * SSR-safe: all state is created per call, nothing at module scope.
 */
export function useLargeCollection<T extends object>(
  options: LargeCollectionOptions<T>,
): LargeCollection<T> {
  const { key, initial } = options

  // The live array. Held in a local binding as well as in the ref so that the
  // mutating paths get a `T[]` without casting away the public `readonly`.
  let rows: T[] = initial ? [...initial] : []

  const items = shallowRef<readonly T[]>(rows)

  // `revision` is genuinely reactive; `index` deliberately is not. See the
  // `markRaw` note in the function doc above.
  const meta = reactive({
    revision: 0,
    index: markRaw(new Map<string, T>()),
  })

  function reindex(): void {
    meta.index.clear()
    for (const row of rows) meta.index.set(key(row), row)
  }

  /**
   * Publish a change that Vue cannot see on its own. `triggerRef` invalidates
   * every effect depending on `items` even though `.value` still points at the
   * same array.
   */
  function commit(): void {
    meta.revision += 1
    triggerRef(items)
  }

  reindex()

  function replaceAll(next: readonly T[]): void {
    rows = [...next]
    items.value = rows
    reindex()
    // No `triggerRef` here: reassigning `.value` is itself the trigger, so this
    // is the one path that does not need one. Only `revision` has to catch up.
    meta.revision += 1
  }

  function append(next: readonly T[]): void {
    if (next.length === 0) return
    for (const row of next) {
      rows.push(row)
      meta.index.set(key(row), row)
    }
    commit()
  }

  function mutate(mutator: (rows: T[]) => void): void {
    mutator(rows)
    // The mutator may have reordered, spliced, or re-keyed anything, so the
    // index is rebuilt wholesale rather than guessed at.
    reindex()
    commit()
  }

  function patch(rowKey: string, changes: Partial<T>): boolean {
    const row = meta.index.get(rowKey)
    if (row === undefined) return false

    Object.assign(row, changes)

    // A patch may move the row's identity — re-key rather than leave the index
    // pointing at a stale string.
    const nextKey = key(row)
    if (nextKey !== rowKey) {
      meta.index.delete(rowKey)
      meta.index.set(nextKey, row)
    }

    commit()
    return true
  }

  function remove(rowKey: string): boolean {
    const row = meta.index.get(rowKey)
    if (row === undefined) return false

    const at = rows.indexOf(row)
    if (at !== -1) rows.splice(at, 1)
    meta.index.delete(rowKey)

    commit()
    return true
  }

  function clear(): void {
    rows = []
    items.value = rows
    meta.index.clear()
    meta.revision += 1
  }

  return {
    items,
    size: computed(() => items.value.length),
    revision: computed(() => meta.revision),
    index: meta.index,
    find: (rowKey: string) => meta.index.get(rowKey),
    replaceAll,
    append,
    mutate,
    patch,
    remove,
    clear,
  }
}
