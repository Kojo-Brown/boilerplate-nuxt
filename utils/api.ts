import type { ResolvedFetchOptions } from 'ofetch'

interface RequestMeta {
  correlationId: string
  startTime: number
}

// $fetch is a Nuxt global (ofetch) — available at runtime via auto-imports.
// onRequest attaches per-request tracking metadata to the resolved options so
// onResponse can read it back; intersecting with ofetch's own options type keeps
// the assertion a widening of the real type rather than a reinterpretation of it.
type AugmentedOptions = ResolvedFetchOptions & { _meta?: RequestMeta }

export function createApiClient(baseOptions: Record<string, unknown> = {}) {
  return $fetch.create({
    baseURL: '/api',
    ...baseOptions,

    onRequest({ options }) {
      const correlationId = crypto.randomUUID()
      const headers = new Headers(options.headers)
      headers.set('x-correlation-id', correlationId)
      headers.set('x-client-timestamp', String(Date.now()))
      options.headers = headers
      ;(options as AugmentedOptions)._meta = {
        correlationId,
        startTime: Date.now(),
      }
    },

    onResponse({ request, response, options }) {
      if (process.env['NODE_ENV'] === 'production') return
      const meta = (options as AugmentedOptions)._meta
      const latency = meta != null ? Date.now() - meta.startTime : 0
      // Deliberate dev-only request tracing — the production early-return above
      // means this never runs in a live bundle.
      // eslint-disable-next-line no-console
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
