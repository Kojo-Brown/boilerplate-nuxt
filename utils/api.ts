import type { ResolvedFetchOptions } from 'ofetch'

import { browserCsrfSource, resolveCsrfToken } from './csrf'
import { CSRF_HEADER_NAME, isStateChangingMethod } from '~/types/csrf'

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

    // Async because of the CSRF header below, and everything before the first
    // `await` still runs synchronously — which is why the correlation id and
    // `_meta` are set first. ofetch awaits this interceptor before it sends, and
    // `headers` is the same object `options.headers` already points at, so a
    // value set after the await is still on the request.
    async onRequest({ options }) {
      const correlationId = crypto.randomUUID()
      const headers = new Headers(options.headers)
      headers.set('x-correlation-id', correlationId)
      headers.set('x-client-timestamp', String(Date.now()))
      options.headers = headers
      ;(options as AugmentedOptions)._meta = {
        correlationId,
        startTime: Date.now(),
      }

      // The CSRF header, for everything that goes through this client — which
      // is `useApi()` and the HTTP todo gateway, so most of the app's writes.
      // Only on the methods `server/middleware/20.csrf.ts` actually checks: a
      // `GET` that fetched a token first would turn every read into two
      // requests for a header the server ignores. See `utils/csrf.ts` for why
      // this is not an interceptor installed on the global `$fetch`.
      if (!isStateChangingMethod(options.method)) return

      const token = await resolveCsrfToken(browserCsrfSource())
      if (token !== null) headers.set(CSRF_HEADER_NAME, token)
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
