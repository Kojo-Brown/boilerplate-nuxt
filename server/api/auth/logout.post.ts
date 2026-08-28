import { logoutSchema, type LogoutInput } from '~/server/utils/auth-schemas'
import type { AuthenticatedRequestAuth } from '~/server/utils/request-auth'
import {
  revokeAllSessionsForUser,
  revokeSession,
  useSessionStore,
} from '~/server/utils/session-store'

export interface LogoutResult {
  ok: true
  /** How many sessions were revoked — 0 when the caller had none registered. */
  revoked: number
}

/**
 * Sign out, and mean it.
 *
 * `nuxt-auth-utils` already exposes `DELETE /api/_auth/session`, which is what
 * `useUserSession().clear()` calls, and that is all the client needs to forget
 * the cookie. It is not all the *server* needs: a sealed cookie stays valid
 * until it expires no matter what the browser does with its copy, so a session
 * ends on the server only if the registry says so.
 *
 * This route does both — revoke, then clear — and is the one `useAuth().logout()`
 * calls. The built-in route is left in place; it is still the right thing for a
 * client that only wants to drop its own cookie.
 *
 * It sits under `/api/auth/**`, which `server/utils/access-policy.ts` marks
 * `public`, so signing out without a session is a no-op that returns 200 rather
 * than a 401. Logging out is not an operation a caller should have to be logged
 * in to attempt.
 */
export default defineEventHandler(async (event): Promise<LogoutResult> => {
  const result = await readValidatedBody(event, (raw) => logoutSchema.safeParse(raw ?? {}))

  if (!result.success) {
    throw createError({
      statusCode: 422,
      message: result.error.issues[0]?.message ?? 'Invalid request body',
    })
  }

  const auth = event.context.auth

  try {
    const revoked = auth?.authenticated ? await revoke(auth, result.data.scope) : 0
    await clearUserSession(event)
    return { ok: true, revoked }
  } catch (error) {
    // The cookie is dropped either way — a caller who asked to sign out should
    // not stay signed in on this browser because a store was unreachable. But
    // the *server-side* revocation is what they actually asked for, so a failure
    // is reported rather than swallowed: "signed out everywhere" that quietly
    // did not happen is worse than an error the client can retry.
    await clearUserSession(event)
    console.error('[auth] logout could not revoke sessions:', error)
    throw createError({
      statusCode: 503,
      message:
        'Signed out on this device, but the session registry was unreachable, so other ' +
        'sessions were not revoked. Retry to revoke them.',
      data: { requestId: event.context.requestId },
    })
  }
})

async function revoke(
  auth: AuthenticatedRequestAuth,
  scope: LogoutInput['scope'],
): Promise<number> {
  const store = useSessionStore()

  if (scope === 'all') {
    return revokeAllSessionsForUser(store, auth.user.id)
  }

  // A session issued before the registry existed carries no id, so there is no
  // record to revoke — clearing the cookie is all that is on offer.
  if (!auth.sessionId) return 0

  return (await revokeSession(store, auth.user.id, auth.sessionId)) ? 1 : 0
}
