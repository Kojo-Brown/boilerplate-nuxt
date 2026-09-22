import type { H3Event } from 'h3'

import { createCspNonce } from '~/server/utils/csp-nonce'
import { normalisePathname } from '~/server/utils/request-path'
import {
  buildSecurityHeaders,
  isSecureRequest,
  resolveSecurityConfig,
  servesSharedHtml,
} from '~/server/utils/security-headers'

/**
 * The one function that turns an `H3Event` into security response headers.
 *
 * Split out from `server/utils/security-headers.ts` (which is pure data and
 * knows nothing about Nitro) and from `server/plugins/security-headers.ts`
 * (which is registration and nothing else), so that the request-shaped half can
 * be exercised with a fake event and no plugin machinery.
 *
 * ## The nonce
 *
 * Minted here, published on `event.context.cspNonce`, and written into the
 * document by `server/plugins/security-headers.ts` when Nuxt renders it. One
 * value per response, generated before anything can render, because the header
 * and the markup have to come from the same request or neither is worth
 * anything.
 *
 * Paths whose HTML is shared — prerendered, or cached by an `swr` / `isr` route
 * rule — get no nonce and a policy that says so. `servesSharedHtml` derives that
 * set from `route-rules.config.ts`, and the module note in
 * `server/utils/security-headers.ts` explains why a shared body cannot carry a
 * per-request value.
 */
export function applySecurityHeaders(event: H3Event): void {
  const config = resolveSecurityConfig(useRuntimeConfig(event))

  const nonce = servesSharedHtml(normalisePathname(event.path)) ? null : createCspNonce()
  if (nonce) event.context.cspNonce = nonce

  const headers = buildSecurityHeaders({
    nonce,
    dev: import.meta.dev,
    secure: isSecureRequest({
      forwardedProto: getRequestHeader(event, 'x-forwarded-proto'),
      socket: event.node?.req?.socket,
    }),
    config,
  })

  for (const [name, value] of Object.entries(headers)) {
    setResponseHeader(event, name, value)
  }
}
