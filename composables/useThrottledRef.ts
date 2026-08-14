import { deferredRef, throttlePlan } from '../utils/deferredRef'
import type { DeferredRef, ThrottlePlanOptions } from '../utils/deferredRef'

export type ThrottledRefOptions = ThrottlePlanOptions

/**
 * A ref that publishes at most one write per `interval` ms, keeping the newest.
 *
 * Reach for this instead of {@link useDebouncedRef} when the values in the
 * middle of a burst matter. A dragged handle, a scroll offset, a live cursor
 * position: debouncing those shows nothing until the user stops moving, while
 * throttling shows steady movement at a rate the app can afford.
 *
 * The first write of a burst commits immediately (`leading`) and the last one
 * commits when the window closes (`trailing`), so a burst is never truncated —
 * the final resting position is always published.
 *
 * @example
 * ```ts
 * const scrollY = useThrottledRef(0, 100)
 *
 * onMounted(() => {
 *   const onScroll = () => (scrollY.value = window.scrollY)
 *   window.addEventListener('scroll', onScroll, { passive: true })
 *   onScopeDispose(() => window.removeEventListener('scroll', onScroll))
 * })
 *
 * // Re-runs ~10 times a second while scrolling, not ~60.
 * watch(scrollY, (y) => reportViewport(y))
 * ```
 *
 * @param value Initial value. Committed, not deferred.
 * @param interval Minimum milliseconds between commits.
 */
export function useThrottledRef<T>(
  value: T,
  interval = 300,
  options: ThrottledRefOptions = {},
): DeferredRef<T> {
  // See `useDebouncedRef` — a deferred write never lands during a render pass,
  // so the server writes through.
  return deferredRef(value, throttlePlan<T>(interval, options), { defer: !import.meta.server })
}
