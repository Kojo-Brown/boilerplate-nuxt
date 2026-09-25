import { useCsrfConfig } from '~/server/utils/csrf-config'
import { ensureCsrfCookie } from '~/server/utils/csrf-cookie'
import { CSRF_HEADER_NAME } from '~/types/csrf'

export interface CsrfTokenResponse {
  /** The value to echo in `x-csrf-token`. Also set as a cookie on this response. */
  token: string
  /** Seconds the token remains valid, for a client that wants to pre-empt expiry. */
  expiresIn: number
  /** The header to send it in, so a consumer does not have to hard-code the name. */
  header: string
}

/**
 * Hands out a CSRF token to a caller that has none.
 *
 * `server/middleware/20.csrf.ts` writes the cookie on document responses, which
 * covers an ordinary page load and therefore almost every visitor. This route is
 * for the cases it deliberately does not cover: a first page that was
 * prerendered or `swr`-cached (a `Set-Cookie` on a shared body would hand one
 * visitor's token to every other), a tab that has been navigating client-side
 * for longer than the token's lifetime, and any non-browser consumer of this
 * API.
 *
 * `GET`, and safe: it changes no state the app owns, it is idempotent in the
 * sense that matters — a caller holding a good token gets that same token back
 * rather than a new one — and a token is not a capability on its own. It is the
 * *pair* of a token and this origin's cookie jar that authorises anything, and
 * a cross-origin page can obtain neither: it cannot read this response body
 * (no CORS headers are sent for it) and it cannot read the cookie.
 *
 * Under `/api/auth/**`, which `server/utils/access-policy.ts` marks `public`,
 * because a client needs a token before it can sign in — login is itself a
 * state-changing request and is checked like every other one.
 */
export default defineEventHandler(async (event): Promise<CsrfTokenResponse> => {
  // Never cached, by Nitro or by anything in front of it: the body carries a
  // per-caller value, and the response sets a cookie.
  setResponseHeader(event, 'cache-control', 'no-store')

  const config = await useCsrfConfig().catch((error: unknown) => {
    // The only way here is a server with no seal key, which cannot issue a
    // session either — see the note in `server/middleware/20.csrf.ts`. Reported
    // rather than swallowed, because a client that asked for a token and got
    // nothing needs to know why.
    console.error('[csrf] cannot mint a token:', error)
    throw createError({
      statusCode: 503,
      message: 'CSRF tokens are unavailable because the server has no session password.',
      data: { requestId: event.context.requestId },
    })
  })

  const { token } = await ensureCsrfCookie(event, config)

  return { token, expiresIn: config.ttlSeconds, header: CSRF_HEADER_NAME }
})
