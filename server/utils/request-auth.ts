import type { H3Event } from 'h3'
import type { User } from '#auth-utils'

/**
 * The request-scoped view of who is calling.
 *
 * `server/middleware/10.auth.ts` puts one of these on `event.context.auth` for
 * every request the access policy manages, so a handler reads one typed
 * property instead of awaiting the session and hand-checking `.user`.
 *
 * It is a discriminated union rather than `{ user: User | null }` on purpose.
 * `auth.user` is `User` — not `User | undefined` — everywhere the discriminant
 * has been narrowed, which is what removes the `!` that a nullable user
 * otherwise breeds. `requireAuth(event)` does that narrowing by throwing, so the
 * common case (a handler behind an `authenticated` rule) never has to.
 *
 * What this is *not* is a second source of truth for the session. It is derived
 * from `getUserSession(event)` once per request and never written back; the
 * session cookie remains the only thing that grants access.
 */
export interface AnonymousRequestAuth {
  readonly authenticated: false
  readonly user: null
  readonly sessionId: null
}

export interface AuthenticatedRequestAuth {
  readonly authenticated: true
  readonly user: User
  readonly sessionId: string | null
}

export type RequestAuth = AnonymousRequestAuth | AuthenticatedRequestAuth

/**
 * The value used for every request the policy does not manage, and for a
 * managed request that arrives without a session. Frozen and shared: it carries
 * no request-specific data, so allocating one per request would buy nothing.
 */
export const ANONYMOUS_AUTH: AnonymousRequestAuth = Object.freeze({
  authenticated: false,
  user: null,
  sessionId: null,
})

/** The shape of `getUserSession()`'s result that this module actually reads. */
export interface SessionLike {
  id?: string | undefined
  user?: User | null | undefined
}

/**
 * Projects a session onto {@link RequestAuth}.
 *
 * A session object always exists — h3 mints an empty one for a request with no
 * cookie — so "is there a session" is the wrong question. The question is
 * whether it carries a user, which is the same test `requireUserSession()` in
 * nuxt-auth-utils makes.
 */
export function createRequestAuth(session: SessionLike | null | undefined): RequestAuth {
  const user = session?.user
  if (!user) return ANONYMOUS_AUTH

  return {
    authenticated: true,
    user,
    sessionId: session?.id ?? null,
  }
}

/** Type guard, for the handful of places that branch instead of throwing. */
export function isAuthenticated(auth: RequestAuth): auth is AuthenticatedRequestAuth {
  return auth.authenticated
}

/**
 * Reads `event.context.auth` and narrows it to an authenticated request, or
 * throws the HTTP error that says why it could not.
 *
 * The two failures are deliberately different. A 401 means the caller has no
 * session — an ordinary outcome, and what a client should act on. A 500 means
 * *this server* is misconfigured: the handler sits on a path the access policy
 * calls `unmanaged`, so nothing ever resolved an auth context for it. Returning
 * 401 there would send a client off to log in over a bug it cannot fix, so the
 * message names the two files that have to agree instead.
 */
export function requireAuth(event: H3Event): AuthenticatedRequestAuth {
  const auth = event.context.auth

  if (auth === undefined) {
    throw createError({
      statusCode: 500,
      message:
        `No auth context for ${event.path}. ` +
        'server/middleware/10.auth.ts only resolves one for paths the access ' +
        'policy manages — add a rule for this path in server/utils/access-policy.ts.',
    })
  }

  if (!auth.authenticated) {
    throw createError({ statusCode: 401, message: 'Authentication required' })
  }

  return auth
}
