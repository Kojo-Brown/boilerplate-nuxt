import { resolveAccess } from '~/server/utils/access-policy'
import { normalisePathname } from '~/server/utils/request-path'
import { createRequestAuth } from '~/server/utils/request-auth'

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
})
