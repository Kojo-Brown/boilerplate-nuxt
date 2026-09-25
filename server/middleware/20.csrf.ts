import type { H3Event } from 'h3'

import { useCsrfConfig, type CsrfConfig } from '~/server/utils/csrf-config'
import { ensureCsrfCookie, readCsrfCookie } from '~/server/utils/csrf-cookie'
import {
  classifyRequestSite,
  csrfTokenRequired,
  decideCsrf,
  inspectCsrfToken,
  type CsrfFailure,
} from '~/server/utils/csrf'
import { normalisePathname } from '~/server/utils/request-path'
import { servesSharedHtml } from '~/server/utils/security-headers'
import {
  CSRF_ENDPOINT,
  CSRF_ERROR_CODE,
  CSRF_HEADER_NAME,
  isStateChangingMethod,
} from '~/types/csrf'

/**
 * The CSRF gate, and the only place this app hands a token out by itself.
 *
 * Runs after `10.auth.ts` (see the filename-ordering note in
 * `00.request-context.ts`) and before every route handler. All of the judgement
 * lives in `server/utils/csrf.ts`, which is pure and unit-tested; this file is
 * the three things that cannot be — reading the request, writing the cookie, and
 * throwing.
 *
 * It runs *after* auth rather than before so that a request which is both
 * unauthenticated and forged is answered 401, not 403: the caller has no session
 * for anyone to forge a request with, and telling them about a token they do not
 * need would be a worse answer to a worse question. It costs nothing, because
 * the gate below does not read the session at all.
 *
 * ## Enforcement: every state-changing request, every path
 *
 * Not only `/api`. `server/utils/access-policy.ts` deliberately leaves pages and
 * assets `unmanaged` — unsealing a session cookie for every `.js` chunk would be
 * pure overhead — but "this path has no handler that changes state" is a claim
 * about the routes that exist today, and the cost of checking is two header
 * reads and, at most, one HMAC. So the gate is universal and the exceptions are
 * the two lists in `server/utils/csrf.ts`: safe methods, and the origin-only
 * paths.
 *
 * ## Issuance: document responses, and the mint endpoint
 *
 * A token is written on the response to a **document** request — a real page
 * load — and nowhere else. That is the narrow rule, and the narrowness is the
 * point: a `Set-Cookie` on anything that might be cached would hand one
 * visitor's token to everyone the cache serves next, and this app has three
 * kinds of cached response (`swr`/`isr` route rules, `defineCachedEventHandler`
 * under `/api/cached/**`, and every static asset under `/_nuxt/`, which a CDN
 * will happily keep). Restricting issuance to documents means the only thing
 * that has to be excluded is shared HTML, which `servesSharedHtml` already
 * derives from `route-rules.config.ts` for the CSP nonce — for exactly the same
 * reason, one request's value cannot go in a body many requests share.
 *
 * Everything that is not a page load gets its token from {@link CSRF_ENDPOINT},
 * which `server/api/auth/csrf.get.ts` serves `no-store`. That covers a visitor
 * whose first page was a prerendered one, a session that has been navigating
 * client-side for longer than the token's life, and any non-browser consumer.
 *
 * ## When the app has no seal key
 *
 * `useCsrfConfig()` derives the signing key from `session.password` and throws
 * when there is none. That happens in exactly two places: prerendering, and a
 * `pnpm dev` first run before `nuxt-auth-utils` has written a key to `.env`.
 * Both are handled by letting the request through with a warning rather than by
 * failing, and the reasoning is not leniency: with no seal key there are no
 * sealed sessions, so there is no ambient authority for a forged request to
 * borrow. A deployment that is actually serving cannot reach this branch —
 * `server/plugins/session-hardening.ts` refuses to boot without a key.
 */
export default defineEventHandler(async (event) => {
  // Nothing about a prerender is a request from a browser: there is no cookie
  // jar to write to and no caller to forge anything.
  if (import.meta.prerender === true) return

  const method = event.method
  const stateChanging = isStateChangingMethod(method)
  const pathname = normalisePathname(event.path)
  const issuing = !stateChanging && wantsToken(event, pathname)

  if (!stateChanging && !issuing) return

  const config = await loadConfig()
  if (config === null) return

  if (stateChanging) {
    await enforce(event, {
      method,
      pathname,
      config,
      cookieToken: readCsrfCookie(event),
    })
    return
  }

  // Leaves a still-good token alone; see `ensureCsrfCookie`.
  await ensureCsrfCookie(event, config)
})

interface EnforceInput {
  readonly method: string | undefined
  readonly pathname: string
  readonly config: CsrfConfig
  readonly cookieToken: string | undefined
}

async function enforce(event: H3Event, input: EnforceInput): Promise<void> {
  const tokenRequired = csrfTokenRequired(input.pathname)

  const site = classifyRequestSite({
    secFetchSite: getRequestHeader(event, 'sec-fetch-site'),
    origin: getRequestHeader(event, 'origin'),
    host: getRequestHeader(event, 'host'),
    allowedOrigins: input.config.allowedOrigins,
  })

  // The cookie's signature is only checked when a token is actually required and
  // one was presented, so a cross-origin caller cannot make this app compute an
  // HMAC — the site check above has already rejected them by here.
  const cookieState =
    tokenRequired && input.cookieToken !== undefined && site === 'same-origin'
      ? await inspectCsrfToken(input.cookieToken, { key: input.config.key })
      : undefined

  const decision = decideCsrf({
    method: input.method,
    site,
    tokenRequired,
    cookieToken: input.cookieToken,
    headerToken: getRequestHeader(event, CSRF_HEADER_NAME),
    cookieState,
  })

  if (decision.ok) return

  throw createError({
    statusCode: 403,
    message: explain(decision.reason),
    data: { code: CSRF_ERROR_CODE, reason: decision.reason, requestId: event.context.requestId },
  })
}

/**
 * Whether this request's response may carry a token.
 *
 * `Sec-Fetch-Dest: document` is the precise signal and every browser that can
 * make a cross-site request sends it. The `Accept` fallback is for the clients
 * that do not — and it is a fallback rather than the primary test because
 * `Accept: text/html` is also what a hand-written `curl` sends, and a token in
 * that response is harmless where a token on a cacheable asset is not.
 *
 * `servesSharedHtml` is the exclusion that matters: those routes' HTML is stored
 * once and served to everyone, so a `Set-Cookie` on them is a token handed to
 * every subsequent visitor. The mint endpoint is how a visitor who landed on one
 * gets a token of their own.
 */
function wantsToken(event: H3Event, pathname: string): boolean {
  if (pathname === CSRF_ENDPOINT) return false
  if (servesSharedHtml(pathname)) return false

  const dest = getRequestHeader(event, 'sec-fetch-dest')
  if (dest !== undefined) return dest === 'document'

  return getRequestHeader(event, 'accept')?.includes('text/html') === true
}

/** `null` when there is no seal key to derive from — see the module note. */
async function loadConfig(): Promise<CsrfConfig | null> {
  try {
    return await useCsrfConfig()
  } catch (error) {
    if (!warnedAboutMissingKey) {
      warnedAboutMissingKey = true
      console.warn(
        '[csrf] no session password, so CSRF checks are not running:',
        error instanceof Error ? error.message : error,
      )
    }
    return null
  }
}

/** One warning per process, not one per request. */
let warnedAboutMissingKey = false

/**
 * The message the client sees.
 *
 * Specific rather than a single "Forbidden", because every one of these is
 * something a developer integrating with this app has to be able to fix, and
 * none of them tells an attacker anything they could not learn by trying. The
 * machine-readable `reason` travels alongside in `data`.
 */
function explain(reason: CsrfFailure): string {
  switch (reason) {
    case 'cross-origin':
      return 'Cross-origin request refused. Add the origin to NUXT_SECURITY_CSRF_ALLOWED_ORIGINS if it is meant to reach this app.'
    case 'no-origin':
      return 'A state-changing request must carry an Origin or Sec-Fetch-Site header.'
    case 'missing-cookie':
      return `No CSRF cookie. Fetch ${CSRF_ENDPOINT} first, then echo the cookie in ${CSRF_HEADER_NAME}.`
    case 'missing-header':
      return `Missing ${CSRF_HEADER_NAME}. Echo the CSRF cookie in it on every state-changing request.`
    case 'mismatched-token':
      return `${CSRF_HEADER_NAME} does not match the CSRF cookie.`
    case 'token-expired':
      return `The CSRF token has expired. Fetch ${CSRF_ENDPOINT} for a new one.`
    default:
      return `The CSRF token is not valid. Fetch ${CSRF_ENDPOINT} for a new one.`
  }
}
