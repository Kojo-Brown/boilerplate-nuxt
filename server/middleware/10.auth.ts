import { resolveAccess } from '~/server/utils/access-policy'
import { normalisePathname } from '~/server/utils/request-path'
import { createRequestAuth, type AuthenticatedRequestAuth } from '~/server/utils/request-auth'
import { readSessionRecord, sessionStatus, useSessionStore } from '~/server/utils/session-store'

/**
 * Request-scoped auth.
 *
 * Runs after `00.request-context.ts` (see the note there on filename ordering)
 * and before every route handler. It does two things and nothing else:
 *
 *  1. Resolves the session **once** and projects it onto `event.context.auth`,
 *     so handlers read a typed, already-narrowed value instead of each awaiting
 *     `getUserSession()` and testing `.user` themselves.
 *  2. Enforces `server/utils/access-policy.ts`. A path the table marks
 *     `authenticated` never reaches its handler without a user.
 *  3. Rejects a session the session registry has marked revoked, which is the
 *     only way a sealed-cookie session can be ended before it expires. See
 *     `server/utils/session-store.ts`.
 *
 * The honest note on (1): h3 already caches the unsealed session on
 * `event.context.sessions`, so calling `getUserSession()` in five handlers costs
 * one decrypt, not five. Resolving here is not a performance fix and should not
 * be sold as one. What it buys is that the check happens in one place that
 * cannot be forgotten, and that the value handlers read is a type whose
 * authenticated case has a non-nullable `user`.
 *
 * The policy is matched against `normalisePathname(event.path)`, not `event.path`
 * — see `server/utils/request-path.ts` for why the difference is a security
 * boundary and not a tidiness one.
 *
 * `unmanaged` paths (pages, payloads, assets) are left alone. The session cookie
 * is not unsealed for them, and `event.context.auth` is not set: page auth is
 * already the route guard's and Nuxt's session plugin's job, and doing the work
 * again for every `.js` chunk would be pure overhead.
 */
export default defineEventHandler(async (event) => {
  const access = resolveAccess(normalisePathname(event.path))

  if (access === 'unmanaged') return

  const session = await getUserSession(event)
  const auth = createRequestAuth(session)
  event.context.auth = auth

  if (access === 'authenticated' && !auth.authenticated) {
    throw createError({
      statusCode: 401,
      message: 'Authentication required',
      data: { requestId: event.context.requestId },
    })
  }

  if (auth.authenticated && (await isRevoked(auth))) {
    // The cookie is cryptographically valid, so the browser will keep sending it
    // until it expires. Clearing it turns one revoked session into one 401
    // rather than a 401 on every subsequent request.
    await clearUserSession(event)
    throw createError({
      statusCode: 401,
      message: 'Session revoked',
      data: { requestId: event.context.requestId },
    })
  }
})

/**
 * One storage read per authenticated request, on the `sessions` base.
 *
 * That cost is real and worth stating plainly: on Redis it is a round trip added
 * to every managed request from a signed-in caller. It buys the only revocation
 * a sealed-cookie session can have. The read is skipped entirely for anonymous
 * callers and for `unmanaged` paths, so page and asset traffic is untouched.
 *
 * A store that is unreachable or slow must not take the app down with it, so a
 * failure here is logged and the request proceeds — the same fail-open stance
 * `session-store.ts` documents for a missing record, and for the same reason:
 * the cookie, not this store, is what grants access.
 */
async function isRevoked(auth: AuthenticatedRequestAuth): Promise<boolean> {
  // h3 mints the session id when the session is created. A session issued before
  // this registry existed has none, and there is nothing to look up.
  if (!auth.sessionId) return false

  try {
    const record = await readSessionRecord(useSessionStore(), auth.user.id, auth.sessionId)
    return sessionStatus(record, Date.now()) === 'revoked'
  } catch (error) {
    console.error('[auth] session registry unreachable, allowing request:', error)
    return false
  }
}
