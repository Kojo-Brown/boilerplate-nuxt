/**
 * The names the CSRF defence uses on the wire.
 *
 * Shared rather than duplicated because both halves have to agree exactly: the
 * server writes the cookie and reads the header (`server/utils/csrf.ts`), the
 * browser reads the cookie and writes the header (`utils/csrf.ts`), and a typo
 * in either place is a 403 on every write rather than a compile error.
 *
 * ## Why there are two cookie names
 *
 * `__Host-` is not decoration. A cookie carrying that prefix is only accepted by
 * the browser when it is `Secure`, has `Path=/`, and has **no `Domain`
 * attribute** — which is precisely what makes it unsettable by a sibling host.
 * That matters here more than anywhere else in the app: this is a double-submit
 * cookie, so an attacker who could plant a cookie on `evil.app.test` and have it
 * sent to `app.test` would be able to choose both halves of the comparison. The
 * prefix is what closes cookie tossing, and it closes it in the browser rather
 * than in code we would have to get right.
 *
 * The prefix also *requires* `Secure`, and Safari has historically refused
 * `Secure` cookies over plain `http://`. `pnpm dev` on `http://localhost` is a
 * supported way to run this app, so the unprefixed name is what a non-TLS
 * request gets: same token, same verification, one property less. Which name is
 * written is decided per request from the same `isSecureRequest` the HSTS header
 * uses, so a deployment behind TLS never sees the weaker one.
 *
 * The client tries the prefixed name first for the same reason: if both exist —
 * a browser that kept a dev cookie and then reached the app over TLS — the
 * stronger one is the one the server just wrote.
 */

/** The cookie a TLS request gets. Unsettable by any other host, by construction. */
export const CSRF_COOKIE_SECURE_NAME = '__Host-csrf'

/** The cookie a plain-HTTP request gets. Dev only in any real deployment. */
export const CSRF_COOKIE_NAME = 'csrf'

/** Both names, most-preferred first. The client reads them in this order. */
export const CSRF_COOKIE_NAMES = [CSRF_COOKIE_SECURE_NAME, CSRF_COOKIE_NAME] as const

/**
 * The header the token comes back in.
 *
 * A header rather than a form field because every state-changing request this
 * app makes is `fetch` with a JSON body, and because a header cannot be set by
 * a cross-origin `<form>` at all — the only way to attach one is a request that
 * is already subject to CORS.
 */
export const CSRF_HEADER_NAME = 'x-csrf-token'

/**
 * Where a client with no cookie gets one.
 *
 * Needed because the cookie is written on responses this app serves, and a
 * visitor can reach a state-changing action without having received one: their
 * first page may have been a prerendered or `swr`-cached route, which is
 * deliberately excluded from issuance (see `server/middleware/20.csrf.ts`), and
 * everything after it may have been client-side navigation.
 */
export const CSRF_ENDPOINT = '/api/auth/csrf'

/** `data.code` on every rejection, so a client can tell CSRF from authorisation. */
export const CSRF_ERROR_CODE = 'CSRF_REJECTED'

/**
 * Methods that cannot change state, and therefore need no token.
 *
 * RFC 9110's safe methods, and the list is the *definition* the rest of the app
 * works from: a handler that mutates something on `GET` is not an exception to
 * be added here, it is a bug. `OPTIONS` is on it because a CORS preflight is
 * sent without credentials and before any handler runs; refusing one would
 * break CORS rather than protect anything.
 *
 * Here rather than in `server/utils/csrf.ts` because both halves need it: the
 * gate decides what to check, and the browser client decides what to attach a
 * header to. One list, so the two cannot disagree about what a write is.
 */
export const SAFE_METHODS = ['GET', 'HEAD', 'OPTIONS', 'TRACE'] as const

/** Whether a request with this method may change state, and so must be checked. */
export function isStateChangingMethod(method: string | undefined): boolean {
  const normalised = (method ?? 'GET').toUpperCase()
  return !SAFE_METHODS.some((safe) => safe === normalised)
}
