import type { H3Event } from 'h3'

import {
  csrfTokenNeedsRefresh,
  inspectCsrfToken,
  mintCsrfToken,
  type CsrfTokenState,
} from '~/server/utils/csrf'
import type { CsrfConfig } from '~/server/utils/csrf-config'
import { isSecureRequest } from '~/server/utils/security-headers'
import { CSRF_COOKIE_NAME, CSRF_COOKIE_NAMES, CSRF_COOKIE_SECURE_NAME } from '~/types/csrf'

/**
 * The request-shaped half of the CSRF defence: reading the cookie and writing it.
 *
 * Separated from `server/utils/csrf.ts` (pure, knows nothing about h3) and from
 * `server/middleware/20.csrf.ts` (enforcement and nothing else) on the same
 * principle as `security-response.ts` — so the part that needs an `H3Event` can
 * be exercised with a fake one, and so the mint endpoint and the middleware
 * share one implementation of "what this cookie looks like" rather than two.
 */

/** Reads whichever of the two cookie names is present, preferring the prefixed one. */
export function readCsrfCookie(event: H3Event): string | undefined {
  for (const name of CSRF_COOKIE_NAMES) {
    const value = getCookie(event, name)
    if (value !== undefined && value !== '') return value
  }
  return undefined
}

/**
 * Mints a token and sets it, under the name the request's scheme supports.
 *
 * `httpOnly: false` is the one attribute that looks wrong and is not: the whole
 * mechanism depends on a script on *this* origin being able to read the value
 * and echo it in a header, which is precisely what a cross-origin script cannot
 * do. A token nobody can read is a token nobody can submit.
 *
 * Returns the token so the mint endpoint can also put it in its body, for a
 * client that would rather not parse `document.cookie`.
 */
export async function writeCsrfCookie(
  event: H3Event,
  config: CsrfConfig,
  now = Date.now(),
): Promise<string> {
  const token = await mintCsrfToken({ key: config.key, ttlSeconds: config.ttlSeconds, now })
  const secure = isSecureRequest({
    forwardedProto: getRequestHeader(event, 'x-forwarded-proto'),
    socket: event.node?.req?.socket,
  })

  setCookie(event, secure ? CSRF_COOKIE_SECURE_NAME : CSRF_COOKIE_NAME, token, {
    // Readable by design — see this function's note.
    httpOnly: false,
    // Decides the cookie's name as well as its attribute: `__Host-` is only
    // accepted on a `Secure` cookie, and `pnpm dev` over plain HTTP is a
    // supported way to run this app. See `types/csrf.ts`.
    secure,
    // `strict` would be stronger and is wrong here: a token that arrives only on
    // same-site requests is missing from exactly the first request after someone
    // follows a link into the app, which is a write refused for a visitor who
    // did nothing unusual. `lax` matches the session cookie, and the header half
    // of the double submit is what a cross-site page cannot produce anyway.
    sameSite: 'lax',
    // `Path=/` and no `Domain` are what the `__Host-` prefix requires. h3 sets no
    // domain unless asked, so the prefix is satisfied by omission — and a browser
    // rejects a `__Host-` cookie outright when it is not, which makes a mistake
    // here fail loudly rather than quietly weaken the cookie.
    path: '/',
    maxAge: config.ttlSeconds,
  })

  return token
}

/**
 * Returns the caller's token, minting and setting a new one only when the one
 * they hold is missing, unverifiable, or past half its life.
 *
 * Reusing a still-good token matters because the cookie jar holds one value: two
 * tabs that each mint on load would leave the one that finished first holding a
 * header that no longer matches the cookie.
 */
export async function ensureCsrfCookie(
  event: H3Event,
  config: CsrfConfig,
  now = Date.now(),
): Promise<{ readonly token: string; readonly state: CsrfTokenState }> {
  const existing = readCsrfCookie(event)
  const state = await inspectCsrfToken(existing, { key: config.key, now })

  if (existing !== undefined && !csrfTokenNeedsRefresh(state, config.ttlSeconds, now)) {
    return { token: existing, state }
  }

  const token = await writeCsrfCookie(event, config, now)
  return { token, state }
}
