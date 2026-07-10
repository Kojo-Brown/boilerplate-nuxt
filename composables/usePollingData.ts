import type { AsyncData, NuxtError } from 'nuxt/app'

export interface PollingOptions {
  /** Polling interval in milliseconds. Default: 10_000 (10 s) */
  interval?: number
  /** Pause polling while the browser tab is hidden. Default: true */
  pauseOnHidden?: boolean
  /** Fetch immediately on mount. Default: true */
  immediate?: boolean
}

export interface PollingControls {
  startPolling: () => void
  stopPolling: () => void
  /** Reactive boolean — true while the interval is active */
  isPolling: Ref<boolean>
}

export type PollingData<T> = AsyncData<T | null, NuxtError> & PollingControls

/**
 * Wraps `useAsyncData` with an automatic polling loop.
 *
 * The interval is started on mount and cleaned up on unmount. When
 * `pauseOnHidden` is true (the default) the loop is suspended while the
 * browser tab is not visible and immediately resumes (with a fresh fetch)
 * when the tab becomes active again.
 */
export function usePollingData<T>(
  key: string,
  fetcher: () => Promise<T>,
  options: PollingOptions = {},
): PollingData<T> {
  const { interval = 10_000, pauseOnHidden = true, immediate = true } = options

  const asyncData = useAsyncData<T>(key, fetcher, { immediate })
  const isPolling = ref(false)

  let timer: ReturnType<typeof setInterval> | null = null

  function stopPolling(): void {
    if (timer !== null) {
      clearInterval(timer)
      timer = null
    }
    isPolling.value = false
  }

  function startPolling(): void {
    stopPolling()
    timer = setInterval(() => {
      if (pauseOnHidden && typeof document !== 'undefined' && document.hidden) return
      void asyncData.refresh()
    }, interval)
    isPolling.value = true
  }

  function handleVisibilityChange(): void {
    if (document.hidden) {
      stopPolling()
    } else {
      startPolling()
      void asyncData.refresh()
    }
  }

  if (import.meta.client) {
    onMounted(() => {
      startPolling()
      if (pauseOnHidden) {
        document.addEventListener('visibilitychange', handleVisibilityChange)
      }
    })

    onUnmounted(() => {
      stopPolling()
      if (pauseOnHidden) {
        document.removeEventListener('visibilitychange', handleVisibilityChange)
      }
    })
  }

  return {
    ...asyncData,
    startPolling,
    stopPolling,
    isPolling: readonly(isPolling) as Ref<boolean>,
  }
}
