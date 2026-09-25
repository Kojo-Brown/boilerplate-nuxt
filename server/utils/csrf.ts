/**
 * Cross-site request forgery: the decision, with no Nitro in it.
 *
 * `server/middleware/20.csrf.ts` is the enforcement; this module is everything
 * it decides with. Split for the same reason `security-headers.ts` is split
 * from `security-response.ts` — a gate whose logic can only be exercised by
 * standing up a server is a gate whose edge cases are never tested.
 *
 * ## What the attack is here, given everything else this app already does
 *
 * The session is a sealed, `httpOnly`, `SameSite=Lax` cookie
 * (`server/utils/session-hardening.ts`). That is ambient authority: the browser
 * attaches it to a request because of where the request is *going*, never
 * because of where it came *from*. So any page on the internet that can cause
 * this app's origin to receive a `POST` causes it to receive an authenticated
 * one.
 *
 * `SameSite=Lax` already removes most of that. A cross-**site** POST does not
 * carry the cookie at all, which is why this module is a second layer rather
 * than the first. What Lax does not cover is the part worth writing code for:
 *
 *  - **Same site, different origin.** `https://cdn.app.test` and
 *    `http://app.test:3000` are the same *site* as `https://app.test` and their
 *    requests carry the cookie. A subdomain someone else controls — a
 *    marketing page, a staging box, a bucket with a CNAME — is a working CSRF
 *    vector that Lax says nothing about.
 *  - **Clients that do not implement it.** Lax is a browser behaviour, not a
 *    server check, and an old or unusual client that ignores the attribute is a
 *    client the server has to answer for.
 *  - **`Lax` means Lax, not Strict.** A top-level cross-site *navigation* sends
 *    the cookie. Nothing under `/api` changes state on `GET`, which is what
 *    makes that survivable — and "nothing does" is an invariant, so
 *    {@link isStateChangingMethod} is what defines the set this module guards
 *    rather than a list someone keeps in their head.
 *
 * ## The two checks
 *
 * **1. The request's site**, from `Sec-Fetch-Site` or `Origin`. This is the
 * strong one and it costs nothing: a browser sets both itself and a page cannot
 * override either. See {@link classifyRequestSite} for what each value means and
 * for why a request with neither header is refused rather than waved through.
 *
 * **2. A signed double-submit token**, in a cookie and echoed in a header. This
 * is the one that survives a header being stripped by an intermediary, or a
 * `Sec-Fetch-Site` this app's allowlist had to widen for a legitimate sibling
 * origin. Two properties make it worth having rather than ceremony:
 *
 *  - The token is a MAC under a key derived from the session password
 *    (`server/utils/csrf-config.ts`), so it cannot be *invented* — a plain
 *    double-submit accepts any value that appears in both places, which an
 *    attacker who can set a cookie can arrange.
 *  - The cookie is written under the `__Host-` prefix on every TLS request
 *    (`types/csrf.ts`), so it cannot be *planted* by a sibling host either.
 *
 * Between them, forging a token needs the signing key and stealing one needs
 * code running on this exact origin — which is XSS, at which point CSRF is not
 * the problem being solved.
 *
 * ## What is deliberately not here
 *
 * **`Referer`.** It is the traditional third fallback and it is the wrong one:
 * it is stripped by privacy tooling and by `Referrer-Policy: no-referrer`, so
 * accepting it means accepting a header that legitimate traffic often lacks,
 * and *requiring* it means breaking that traffic. `Origin` carries the same
 * information, is not suppressed by referrer policy on state-changing requests,
 * and is what browsers have sent on them for years.
 *
 * **Per-session binding.** An earlier shape of this bound the token to the
 * signed-in user, so that a token minted for one account could not be used
 * against another. It is not here because the `__Host-` prefix already stops the
 * attack that binding defends against — planting your token in someone else's
 * browser — and because binding puts the token's validity on the same clock as
 * session rotation (`server/utils/session-rotation.ts`), which replaces the
 * session id every fifteen minutes. That would invalidate a perfectly good token
 * mid-session, on a schedule, in exchange for nothing the cookie prefix does not
 * already provide.
 */
import { createHash, timingSafeEqual } from 'node:crypto'

import { isStateChangingMethod } from '~/types/csrf'

/**
 * Where a request says it came from.
 *
 * `same-origin` is the only value that proceeds. `unknown` is its own case
 * rather than being folded into `cross-origin` so that the rejection can say
 * which of the two happened — they have very different causes and a caller
 * debugging one should not be shown the other's explanation.
 */
export type RequestSite = 'same-origin' | 'cross-origin' | 'unknown'

export interface SiteSignals {
  /** `Sec-Fetch-Site`. Set by the browser, unsettable by the page. */
  readonly secFetchSite: string | undefined
  /** `Origin`. Present on every state-changing request a browser makes. */
  readonly origin: string | undefined
  /** The request's own `Host` header, as the app is addressed. */
  readonly host: string | undefined
  /** Extra origins to accept, from `NUXT_SECURITY_CSRF_ALLOWED_ORIGINS`. */
  readonly allowedOrigins: readonly string[]
}

/**
 * Decides whether a state-changing request came from this app's own origin.
 *
 * ## `Sec-Fetch-Site` first
 *
 * It is a Fetch Metadata header: the browser computes it from the relationship
 * between the initiator and the target and forbids script from setting it, so
 * unlike `Origin` it cannot be omitted by a page that would rather not send one.
 * The four values are read as:
 *
 *  - `same-origin` — the initiator is this exact origin. Accepted.
 *  - `none` — there was no initiator: a bookmark, a typed URL, a redirect the
 *    user started. Accepted, because no other page caused it, which is the whole
 *    definition of the attack.
 *  - `same-site` — a sibling origin. **Rejected** unless the allowlist names it.
 *    This is the case `SameSite=Lax` lets through and the main reason this check
 *    exists.
 *  - `cross-site` — rejected, unless allowlisted.
 *
 * An unrecognised value falls through to `Origin` rather than being trusted or
 * refused on its own: a header this app does not understand should not be the
 * thing that decides.
 *
 * ## `Origin` second
 *
 * Compared by **host**, not by full origin, for the reason
 * `server/utils/ws-handshake.ts` gives at more length: the upgrade — and every
 * ordinary request — arrives as `http:` behind a TLS terminator far more often
 * than it arrives as `https:` end to end, so a page on `https://app.test`
 * reaches a handler whose own `Host` says `app.test` and whose scheme says
 * `http`. Comparing schemes there would refuse every request in every deployment
 * that terminates TLS at a proxy. An allowlist entry is matched on the full
 * serialised origin, where scheme and port *are* significant, because that entry
 * was written by an operator naming a specific sibling.
 *
 * ## Neither header: `unknown`, which the caller refuses
 *
 * Every browser in use sends `Origin` on a request whose method is not `GET` or
 * `HEAD` — form posts included, `sendBeacon` included, and regardless of CORS
 * mode. So on a state-changing request its absence means the caller is not a
 * browser: `curl`, a server-to-server client, a test harness. Those are exactly
 * the callers that are *not* subject to CSRF, and they are also the ones that
 * can set the header trivially. Refusing costs them one line of configuration
 * and costs an attacker the entire vector, so the caller refuses — see
 * `docs/csrf.md` for the operator-facing version of that trade.
 */
export function classifyRequestSite(signals: SiteSignals): RequestSite {
  const fetchSite = signals.secFetchSite?.trim().toLowerCase()

  if (fetchSite === 'same-origin' || fetchSite === 'none') return 'same-origin'

  if (fetchSite === 'same-site' || fetchSite === 'cross-site') {
    return isAllowedOrigin(signals) ? 'same-origin' : 'cross-origin'
  }

  const origin = signals.origin?.trim()
  if (origin === undefined || origin === '') return 'unknown'

  return isAllowedOrigin(signals) ? 'same-origin' : 'cross-origin'
}

/** `Origin` against the request's own host, then against the operator's list. */
function isAllowedOrigin(signals: SiteSignals): boolean {
  const parsed = safeUrl(signals.origin?.trim() ?? '')
  if (parsed === null) return false

  const host = signals.host?.trim()
  if (host !== undefined && host !== '' && host === parsed.host) return true

  return signals.allowedOrigins.some((entry) => safeUrl(entry)?.origin === parsed.origin)
}

/** `new URL` throws on anything unparseable, including the literal `"null"` origin. */
function safeUrl(value: string): URL | null {
  try {
    return new URL(value)
  } catch {
    return null
  }
}

/**
 * Splits `NUXT_SECURITY_CSRF_ALLOWED_ORIGINS` into origins. Also accepts an
 * array, which is what `runtimeConfig` yields when the value is set in
 * `nuxt.config.ts` rather than in the environment.
 */
export function parseCsrfOrigins(raw: string | readonly string[] | undefined): string[] {
  const entries = typeof raw === 'string' ? raw.split(',') : (raw ?? [])
  return entries.map((entry) => entry.trim()).filter((entry) => entry !== '')
}

/** Default token lifetime. Long enough to span a working session, short enough to expire. */
export const DEFAULT_CSRF_TTL_SECONDS = 60 * 60 * 12

/** Floor on the configured lifetime. Below this, an open tab starts failing writes. */
export const MIN_CSRF_TTL_SECONDS = 300

/** Ceiling. A token is a bearer value in a JS-readable cookie; a week is plenty. */
export const MAX_CSRF_TTL_SECONDS = 60 * 60 * 24 * 7

/** Clamps a configured TTL into {@link MIN_CSRF_TTL_SECONDS}…{@link MAX_CSRF_TTL_SECONDS}. */
export function clampCsrfTtl(value: number | string | undefined): number {
  const parsed = typeof value === 'string' ? Number(value) : value
  if (parsed === undefined || !Number.isFinite(parsed)) return DEFAULT_CSRF_TTL_SECONDS
  return Math.min(MAX_CSRF_TTL_SECONDS, Math.max(MIN_CSRF_TTL_SECONDS, Math.floor(parsed)))
}

/** Bytes of randomness in a token. 16 is the width of a UUID and past any birthday bound. */
const CSRF_SALT_BYTES = 16

/** Field separator. Not in base64url's alphabet, so it cannot occur inside a field. */
const FIELD_SEPARATOR = '.'

/** What {@link inspectCsrfToken} concluded. */
export type CsrfTokenStatus = 'valid' | 'malformed' | 'expired' | 'invalid'

export interface CsrfTokenState {
  readonly status: CsrfTokenStatus
  /** Epoch milliseconds the token stops being accepted. Only on `valid`. */
  readonly expiresAt?: number
}

export interface CsrfTokenOptions {
  /** HMAC key from `deriveCsrfKey`. */
  readonly key: CryptoKey
  /** Injected so tests do not depend on the wall clock. */
  readonly now?: number
}

/**
 * Mints a token: `<salt>.<expiry>.<mac>`, all base64url except the expiry.
 *
 * The salt is what makes two tokens minted in the same second differ. That is
 * not about unguessability — the MAC already provides that — but about the
 * cookie's value changing whenever it is re-issued, so that a stale copy cached
 * anywhere is visibly not the current one.
 *
 * The expiry is inside the MAC, which is the only reason it can be carried in
 * the clear: a client that edits it invalidates the signature. Encoding it as
 * base-36 seconds rather than milliseconds keeps the field short and the
 * resolution far finer than the minimum lifetime.
 */
export async function mintCsrfToken(
  options: CsrfTokenOptions & { readonly ttlSeconds?: number; readonly salt?: string },
): Promise<string> {
  const now = options.now ?? Date.now()
  const ttl = clampCsrfTtl(options.ttlSeconds ?? DEFAULT_CSRF_TTL_SECONDS)
  const expirySeconds = Math.floor(now / 1000) + ttl
  const salt = options.salt ?? randomSalt()
  const expiry = expirySeconds.toString(36)
  const mac = await sign(options.key, `${salt}${FIELD_SEPARATOR}${expiry}`)

  return [salt, expiry, mac].join(FIELD_SEPARATOR)
}

/**
 * Verifies a token's structure, signature and expiry, in that order.
 *
 * Signature before expiry on purpose: an expired token and a forged one are both
 * refused, and checking the cheap-to-forge field first would let a caller learn
 * whether a *made-up* token's expiry field parsed, which is an oracle for
 * nothing useful but is still an answer given before the signature was checked.
 */
export async function inspectCsrfToken(
  token: string | undefined,
  options: CsrfTokenOptions,
): Promise<CsrfTokenState> {
  if (token === undefined || token === '') return { status: 'malformed' }

  const parts = token.split(FIELD_SEPARATOR)
  if (parts.length !== 3) return { status: 'malformed' }

  const [salt, expiry, mac] = parts
  if (salt === undefined || expiry === undefined || mac === undefined)
    return { status: 'malformed' }
  if (salt === '' || expiry === '' || mac === '') return { status: 'malformed' }

  const expected = await sign(options.key, `${salt}${FIELD_SEPARATOR}${expiry}`)
  if (!constantTimeEquals(mac, expected)) return { status: 'invalid' }

  const expirySeconds = Number.parseInt(expiry, 36)
  if (!Number.isFinite(expirySeconds)) return { status: 'malformed' }

  const expiresAt = expirySeconds * 1000
  if (expiresAt <= (options.now ?? Date.now())) return { status: 'expired' }

  return { status: 'valid', expiresAt }
}

/**
 * Whether a valid token is close enough to expiry to be replaced.
 *
 * Re-issuing at the halfway mark means an active tab never carries a token into
 * its last moments, so the failure this avoids — a write refused because the
 * page was open longer than the TTL — needs the tab to make no safe request for
 * half the lifetime before making a write.
 */
export function csrfTokenNeedsRefresh(
  state: CsrfTokenState,
  ttlSeconds: number,
  now: number,
): boolean {
  if (state.status !== 'valid') return true
  if (state.expiresAt === undefined) return true
  return state.expiresAt - now < (ttlSeconds * 1000) / 2
}

/**
 * The double-submit comparison.
 *
 * Constant-time, and the cookie's own validity is the caller's business: this
 * answers only "are these the same string", which is the half an attacker gets
 * to probe by retrying.
 */
export function tokensMatch(
  cookieToken: string | undefined,
  headerToken: string | undefined,
): boolean {
  if (cookieToken === undefined || headerToken === undefined) return false
  if (cookieToken === '' || headerToken === '') return false
  return constantTimeEquals(cookieToken, headerToken)
}

/** Why a request was refused. Reported to the client; also the log line. */
export type CsrfFailure =
  | 'cross-origin'
  | 'no-origin'
  | 'missing-cookie'
  | 'missing-header'
  | 'mismatched-token'
  | `token-${Exclude<CsrfTokenStatus, 'valid'>}`

export interface CsrfDecisionInput {
  readonly method: string | undefined
  readonly site: RequestSite
  /** `true` for routes that are checked on origin alone — see {@link CSRF_ORIGIN_ONLY_PATHS}. */
  readonly tokenRequired: boolean
  readonly cookieToken: string | undefined
  readonly headerToken: string | undefined
  /** {@link inspectCsrfToken} on the cookie's value, or `undefined` when no token was needed. */
  readonly cookieState: CsrfTokenState | undefined
}

export type CsrfDecision =
  { readonly ok: true } | { readonly ok: false; readonly reason: CsrfFailure }

/**
 * The whole gate, as one pure function of what the request presented.
 *
 * Order matters and is the same order `authorizeHandshake` uses: the free check
 * that needs no secret goes first, so an attacker cannot make this app compute a
 * MAC by posting to it from another origin.
 *
 * The token is verified on the **cookie**, and the header only has to equal it.
 * That is the right way round: the cookie is the copy this server wrote, so
 * verifying it is verifying our own signature, and the header is the proof that
 * whoever sent the request could *read* that cookie — which a cross-origin page
 * cannot. Verifying the header instead would accept any signed token the
 * attacker had ever been issued.
 */
export function decideCsrf(input: CsrfDecisionInput): CsrfDecision {
  if (!isStateChangingMethod(input.method)) return { ok: true }

  if (input.site === 'cross-origin') return { ok: false, reason: 'cross-origin' }
  if (input.site === 'unknown') return { ok: false, reason: 'no-origin' }

  if (!input.tokenRequired) return { ok: true }

  if (input.cookieToken === undefined || input.cookieToken === '') {
    return { ok: false, reason: 'missing-cookie' }
  }
  if (input.headerToken === undefined || input.headerToken === '') {
    return { ok: false, reason: 'missing-header' }
  }

  const state = input.cookieState
  // `undefined` means the caller never inspected the cookie, which it only skips
  // when no token was required — so reaching here with one is a bug in the
  // caller, and refusing is the only safe reading of it.
  if (state === undefined) return { ok: false, reason: 'token-invalid' }
  if (state.status !== 'valid') return { ok: false, reason: `token-${state.status}` }

  if (!tokensMatch(input.cookieToken, input.headerToken)) {
    return { ok: false, reason: 'mismatched-token' }
  }

  return { ok: true }
}

/**
 * Routes checked on origin alone, because a token cannot reach them.
 *
 * Every entry is a hole in the token half of the defence and needs a reason that
 * survives review. The origin half still applies to all of them — that is the
 * point of having two checks that fail independently — and
 * `tests/unit/server/csrf.test.ts` asserts each key still names a live route, so
 * an exemption cannot outlive the endpoint it was opened for.
 *
 * Matching is the same shape as `server/utils/access-policy.ts`: an exact path,
 * or a prefix ending in `/**`, most specific wins.
 */
export const CSRF_ORIGIN_ONLY_PATHS: readonly string[] = [
  // Core Web Vitals ingest. `navigator.sendBeacon` is the only send that
  // survives a page being unloaded and it cannot attach a header — that is the
  // same constraint `server/utils/access-policy.ts` records for why this route
  // is public. A beacon *does* carry `Origin` (a browser appends it to every
  // request whose method is not GET or HEAD, in any CORS mode), so the check
  // that remains is the strong one. What is given up is the layer that would
  // survive a proxy stripping `Origin`, on a route whose worst case is a forged
  // performance metric bounded by the closed enums in
  // `server/utils/vitals-schemas.ts`.
  '/api/vitals',

  // `nuxt-auth-utils`' own session route, which is `GET` (read the session) and
  // `DELETE` (drop the cookie). The `DELETE` is what `useUserSession().clear()`
  // calls, from inside the module's composable, with a `useRequestFetch()` this
  // app has no seam to add a header to — `pages/index.vue` and
  // `composables/useAuth.ts` both go through it. Patching around that would mean
  // either forking the composable or telling everyone not to use the one the
  // module documents.
  //
  // What is given up is bounded and worth naming: CSRF on a sign-*out* is a
  // forced logout, not an action taken as the victim, and the origin check still
  // refuses it from any page that is not this one. The write that actually ends
  // a session server-side is `/api/auth/logout`, which is this app's own route
  // and is not exempt.
  '/api/_auth/session',
]

/** Whether a path must present a token, or is checked on origin alone. */
export function csrfTokenRequired(
  pathname: string,
  originOnly: readonly string[] = CSRF_ORIGIN_ONLY_PATHS,
): boolean {
  return !originOnly.some((pattern) => {
    if (!pattern.endsWith('/**')) return pathname === pattern
    const prefix = pattern.slice(0, -3)
    if (prefix === '') return true
    return pathname === prefix || pathname.startsWith(`${prefix}/`)
  })
}

function randomSalt(): string {
  const bytes = new Uint8Array(CSRF_SALT_BYTES)
  crypto.getRandomValues(bytes)
  return base64url(bytes)
}

async function sign(key: CryptoKey, payload: string): Promise<string> {
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload))
  return base64url(new Uint8Array(signature))
}

function base64url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

/**
 * Length-independent constant-time string comparison.
 *
 * `node:crypto`'s `timingSafeEqual` throws when the two buffers differ in
 * length, and catching that would put the length back into control flow, so
 * both sides are hashed to a fixed width first and the digests are compared.
 * The digest is not a secret — it is of a value the caller just sent us — and
 * this is the standard way to make the comparison total.
 */
function constantTimeEquals(a: string, b: string): boolean {
  return timingSafeEqual(digest(a), digest(b))
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest()
}
