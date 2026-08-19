import { readonly } from 'vue'

export interface Toast {
  id: string
  type: 'success' | 'error' | 'warning' | 'info'
  message: string
  duration: number
}

export interface ToastOptions {
  // `| undefined` is required under exactOptionalPropertyTypes: the convenience
  // helpers below forward an optional argument straight through, so the property
  // may be present-but-undefined, not merely absent.
  type?: Toast['type'] | undefined
  message: string
  duration?: number | undefined
}

/**
 * Schedules the auto-dismiss of a toast. Deliberately has no cancel handle: a
 * handle would have to live somewhere, and the only place shared by every caller
 * is the `useState` payload — which is serialized to the client, where a server
 * timer id means nothing. A dismiss that fires after the toast is already gone
 * is a no-op, because ids are never reused.
 */
export type ToastScheduler = (callback: () => void, delayMs: number) => void

/**
 * The ambient values `useToast` reads. Injected rather than reached for, so a
 * test can make ids deterministic and dismissals synchronous without patching
 * globals — see `docs/composable-design-rules.md`.
 */
export interface ToastDeps {
  /** Wall clock, used for the id prefix. Default: `Date.now`. */
  now: () => number
  /** Randomness for the id suffix. Default: `Math.random`. */
  random: () => number
  /** Runs the auto-dismiss. Default: {@link scheduleOnClient}. */
  schedule: ToastScheduler
}

/**
 * The key `useState` files this list under. Namespaced because the payload is a
 * single flat object shared with every other `useState` call and with Nuxt's
 * own internals.
 */
const TOAST_STATE_KEY = 'app:toasts'

/**
 * The default scheduler: a real timer on the client, nothing on the server.
 *
 * A `setTimeout` created during SSR would fire long after the response was
 * flushed, holding that request's toast list — and everything it closes over —
 * in memory until it did. The trade-off is that a toast added during SSR
 * arrives on the client with no timer behind it and stays until it is dismissed;
 * toasts are a response to a user action, so in practice nothing adds one before
 * hydration.
 */
function scheduleOnClient(callback: () => void, delayMs: number): void {
  if (import.meta.server) return
  setTimeout(callback, delayMs)
}

/**
 * Transient notification state for the current request.
 *
 * State lives in `useState`, not in a module-scope `ref`. A module-scope ref is
 * created once per server *process*, so on the server every request that
 * imported this module would read and write the same array: one visitor's
 * "Payment failed" is rendered into the next visitor's page, and the list only
 * ever grows. `useState` gives one instance per Nuxt app — per request on the
 * server, one for the lifetime of the tab on the client — and serializes it into
 * the payload so the client picks up exactly what was rendered instead of
 * flashing it away on hydration.
 *
 * @param deps Overrides for the ambient values in {@link ToastDeps}. Every field
 *   is optional and defaults to the real thing, so application code calls
 *   `useToast()` and only tests pass anything.
 */
export function useToast(deps: Partial<ToastDeps> = {}) {
  const { now = Date.now, random = Math.random, schedule = scheduleOnClient } = deps

  const toasts = useState<Toast[]>(TOAST_STATE_KEY, () => [])

  function addToast(options: ToastOptions): string {
    const id = `${now()}-${random().toString(36).slice(2)}`
    const toast: Toast = {
      id,
      type: options.type ?? 'info',
      message: options.message,
      duration: options.duration ?? 4000,
    }
    toasts.value.push(toast)
    if (toast.duration > 0) {
      schedule(() => removeToast(id), toast.duration)
    }
    return id
  }

  function removeToast(id: string): void {
    const index = toasts.value.findIndex((t) => t.id === id)
    if (index !== -1) toasts.value.splice(index, 1)
  }

  return {
    toasts: readonly(toasts),
    addToast,
    removeToast,
    success: (message: string, duration?: number) =>
      addToast({ type: 'success', message, duration }),
    error: (message: string, duration?: number) => addToast({ type: 'error', message, duration }),
    warning: (message: string, duration?: number) =>
      addToast({ type: 'warning', message, duration }),
    info: (message: string, duration?: number) => addToast({ type: 'info', message, duration }),
  }
}
