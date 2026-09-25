import { CSRF_COOKIE_NAMES, CSRF_ENDPOINT, CSRF_HEADER_NAME } from '~/types/csrf'

/**
 * The browser's half of the double submit: read the cookie, send it back.
 *
 * `server/middleware/20.csrf.ts` refuses a state-changing request whose
 * `x-csrf-token` header does not match the CSRF cookie it wrote. This module is
 * what produces that header. It is deliberately tiny and deliberately explicit:
 * there is no interceptor installed on the global `$fetch` that would attach it
 * everywhere, because `$fetch` is bound out of `#build/fetch.mjs` when the
 * module that uses it is *evaluated*, so a plugin that replaced it later would
 * have already lost the race for half the app.
 *
 * What that costs is a line per state-changing call site. What it buys is that
 * the mechanism is greppable, and that forgetting it fails closed and loudly —
 * a 403 on the first `pnpm dev` click, not a hole that ships.
 *
 * `utils/api.ts` does it once for everything that goes through the `/api`
 * client, which is most of the app; the remaining raw `$fetch` writes spread
 * {@link csrfRequestInit} into their options.
 *
 * ## Why the I/O is a parameter
 *
 * Everything here that touches `document` or the network is behind
 * {@link CsrfSource}, so the decision — is there a token, and where does one
 * come from — is testable in the `node` environment this project's Vitest runs
 * in. {@link browserCsrfSource} is the one function that reaches for globals,
 * and it answers "no token, and no way to get one" rather than throwing when
 * there is no document, which is what makes calling any of this during SSR a
 * no-op instead of a crash.
 */

/** Where a token comes from. Substituted in tests; see the module note. */
export interface CsrfSource {
  /** `document.cookie`, or `null` where there is no document (SSR, a test). */
  readonly cookies: string | null
  /** Fetches a fresh token from {@link CSRF_ENDPOINT}. `null` if it cannot. */
  readonly mint: () => Promise<string | null>
}

/**
 * Pulls the token out of a `document.cookie` string.
 *
 * Tries `__Host-csrf` before `csrf`: a browser that picked up the unprefixed
 * cookie in dev and later reached the same app over TLS would hold both, and
 * the prefixed one is the one the server most recently wrote. See
 * `types/csrf.ts` for why there are two names at all.
 *
 * Values are `decodeURIComponent`d because that is what wrote them — h3
 * percent-encodes a cookie value on the way out — and a malformed escape yields
 * `null` rather than throwing: a token this cannot read is a token this cannot
 * submit, which the server will say so about far more usefully than a
 * `URIError` thrown out of a click handler.
 */
export function parseCsrfCookie(cookies: string | null): string | null {
  if (cookies === null || cookies === '') return null

  const jar = new Map<string, string>()
  for (const entry of cookies.split(';')) {
    const separator = entry.indexOf('=')
    if (separator === -1) continue
    const name = entry.slice(0, separator).trim()
    if (name === '' || jar.has(name)) continue
    jar.set(name, entry.slice(separator + 1).trim())
  }

  for (const name of CSRF_COOKIE_NAMES) {
    const raw = jar.get(name)
    if (raw === undefined || raw === '') continue
    try {
      return decodeURIComponent(raw)
    } catch {
      return null
    }
  }

  return null
}

/**
 * The token to send, fetching one if this client has none.
 *
 * The cookie is the fast path and is what almost every request takes: the server
 * writes it on every page load. The mint call is for the visitor whose first
 * page was prerendered or `swr`-cached — issuance is skipped there on purpose,
 * because a `Set-Cookie` on a shared body would hand one visitor's token to
 * everyone — and for a tab whose token expired while it was navigating
 * client-side.
 */
export async function resolveCsrfToken(source: CsrfSource): Promise<string | null> {
  const existing = parseCsrfCookie(source.cookies)
  if (existing !== null) return existing
  return source.mint()
}

/**
 * Fetch options carrying the token, or `{}` when there is none.
 *
 * Returning nothing rather than an empty `headers` object matters: spread into a
 * call's options, `{}` leaves whatever headers that call already sets alone,
 * while `{ headers: {} }` would replace them.
 */
export async function csrfRequestInit(
  source: CsrfSource = browserCsrfSource(),
): Promise<{ headers?: Record<string, string> }> {
  const token = await resolveCsrfToken(source)
  return token === null ? {} : { headers: { [CSRF_HEADER_NAME]: token } }
}

/** What the browser can offer. `null` cookies and a no-op mint outside one. */
export function browserCsrfSource(): CsrfSource {
  const inBrowser = typeof document !== 'undefined'

  return {
    cookies: inBrowser ? document.cookie : null,
    mint: async () => {
      if (!inBrowser) return null
      try {
        const response = await $fetch<{ token: string }>(CSRF_ENDPOINT)
        return response.token
      } catch {
        // Nothing useful to do here. The request this token was for will be
        // refused with a 403 that names the reason, which is a better error than
        // one raised from a helper the caller did not know it was invoking.
        return null
      }
    },
  }
}
