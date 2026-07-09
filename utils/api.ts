interface RequestMeta {
  correlationId: string
  startTime: number
}

// $fetch is a Nuxt global (ofetch) — available at runtime via auto-imports.
// We extend the options type with internal tracking metadata.
type AugmentedOptions = Record<string, unknown> & { _meta?: RequestMeta }

export function createApiClient(baseOptions: Record<string, unknown> = {}) {
  return $fetch.create({
    baseURL: '/api',
    ...baseOptions,

    onRequest({ options }) {
      const correlationId = crypto.randomUUID()
      const existing = (options as AugmentedOptions).headers
      const headers = new Headers(existing as HeadersInit | undefined)
      headers.set('x-correlation-id', correlationId)
      headers.set('x-client-timestamp', String(Date.now()))
      ;(options as AugmentedOptions).headers = headers
      ;(options as AugmentedOptions)._meta = {
        correlationId,
        startTime: Date.now(),
      }
    },

    onResponse({ request, response, options }) {
      if (process.env['NODE_ENV'] === 'production') return
      const meta = (options as AugmentedOptions)._meta
      const latency = meta != null ? Date.now() - meta.startTime : 0
      console.debug(
        `[API] ${response.status} ${String(request)} +${latency}ms corr=${meta?.correlationId ?? '?'}`,
      )
    },

    async onResponseError({ response }) {
      if (response.status !== 401) return
      if (typeof window === 'undefined') return
      await navigateTo('/login')
    },

    onRequestError({ request, error }) {
      console.error(`[API] Network error: ${String(request)}`, (error as Error).message)
    },
  })
}
