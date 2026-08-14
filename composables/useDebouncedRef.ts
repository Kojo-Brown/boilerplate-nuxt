import { debouncePlan, deferredRef } from '../utils/deferredRef'
import type { DebouncePlanOptions, DeferredRef } from '../utils/deferredRef'

export type DebouncedRefOptions = DebouncePlanOptions

/**
 * A ref that publishes a write only after the writes stop.
 *
 * The value is stored the moment it is written, but nothing that reads the ref
 * — a `watch`, a `computed`, `useAsyncData` keyed on it — is told until the
 * writes have been quiet for `delay` ms. That is the difference between this
 * and debouncing the *handler*: the debouncing lives in the value, so every
 * consumer gets it, including ones added later that know nothing about it.
 *
 * It is a plain `Ref<T>`, so `v-model` works unchanged. A bound `<input>` does
 * not stutter while a write is deferred: the DOM element holds the typed text,
 * and Vue only patches it when the ref itself changes, which is exactly when
 * the debounce commits the same text back.
 *
 * @example
 * ```ts
 * const query = useDebouncedRef('', 300, { maxWait: 2_000 })
 * const { pending, flush } = query
 *
 * // One request per pause in typing — `query` only changes when it settles.
 * const { data } = await useAsyncData(
 *   'search',
 *   () => $fetch('/api/search', { query: { q: query.value } }),
 *   { watch: [query] },
 * )
 *
 * // `pending` is true between the keystroke and the request; `flush()` on
 * // submit skips the wait.
 * ```
 *
 * @param value Initial value. Committed, not deferred.
 * @param delay Quiet period in milliseconds before a burst of writes commits.
 */
export function useDebouncedRef<T>(
  value: T,
  delay = 300,
  options: DebouncedRefOptions = {},
): DeferredRef<T> {
  // Deferring on the server would drop the write rather than delay it: the
  // render pass resolves before any timer fires, so the markup would be built
  // from the pre-write value and hydration would then disagree with it.
  return deferredRef(value, debouncePlan<T>(delay, options), { defer: !import.meta.server })
}
