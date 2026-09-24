import { randomUUID } from 'node:crypto'

import type { H3Event } from 'h3'
import type { User } from '#auth-utils'

import type { AuthenticatedRequestAuth } from '~/server/utils/request-auth'
import {
  recordSession,
  retireSession,
  revokeSession,
  useSessionStore,
} from '~/server/utils/session-store'

/**
 * Rotating the session id, and capping how long one sign-in can last.
 *
 * ## What rotation is for here
 *
 * A sealed cookie is a bearer credential: whoever holds the bytes is the user,
 * for as long as the seal is valid. `server/utils/session-store.ts` added the
 * ability to end one early. This adds the other half — the session identifier
 * does not stay the same for a week.
 *
 * Two concrete things follow from that, and it is worth being precise, because
 * "rotate the session" is often sold as more than it is:
 *
 *  - **A captured cookie stops working within the rotation interval, not within
 *    the session's lifetime.** The old id is retired once the legitimate client
 *    rotates, so a copy taken an hour ago is dead even though its seal has six
 *    days left. Rotation does not *detect* the theft and does not help while the
 *    attacker is the one doing the rotating.
 *  - **Session fixation has nothing to fix on to.** The id a caller arrives with
 *    is never the id they leave authenticated with: both sign-in paths mint a
 *    fresh session, and rotation keeps re-minting.
 *
 * ## The id that rotates is not h3's
 *
 * h3's `session.id` cannot be rotated, and this is worth stating because the API
 * suggests otherwise. `replaceUserSession` calls `useSession().clear()` and then
 * `update()`; `clear()` deletes the session from `event.context`, and the next
 * read rebuilds it by unsealing the cookie **the request is still carrying** —
 * recovering the same id, which is then truthy, so no new one is minted. Both
 * sign-in paths and this module therefore carry their own identifier, `sid`, in
 * the session data. That is what the registry is keyed on, what sign-in mints
 * fresh (the session-fixation defence), and what rotation replaces.
 *
 * ## The two clocks
 *
 * `issuedAt` is when this person last actually authenticated. It survives
 * rotation, and it is what {@link ROTATION_CONFIG_PATH absoluteMaxAgeSeconds}
 * measures.
 *
 * `rotatedAt` is when the current `sid` was minted, and it is what the rotation
 * interval measures.
 *
 * Both live in the session data, which means both are inside the seal: a client
 * cannot move its own deadline. They are not read from h3's own `createdAt`
 * because `getUserSession()` does not return it — the value exists on
 * `event.context.sessions`, and reaching into that would couple this app to an
 * h3 internal for something the session data can simply carry.
 *
 * ## What the absolute cap adds
 *
 * h3 already bounds a session: `createdAt` survives a reseal too, so the cookie's
 * `Expires` and the seal's TTL both stay anchored to when the session was first
 * created, and rotation does not extend either. The cap is not there to stop an
 * unbounded renewal, then. It is there to make the bound *this app's*: it can be
 * set shorter than the cookie's `maxAge`, it revokes the registry record rather
 * than waiting for a seal to quietly fail, it answers a named 401 instead of
 * looking to the client like a session that was never valid, and it does not
 * depend on an h3 implementation detail that a future version could reasonably
 * change.
 *
 * ## The grace window
 *
 * Rotation is not atomic from the browser's point of view. A page that fires
 * four `$fetch` calls at once sends four requests carrying the same cookie; one
 * of them rotates, and the other three are already in flight with an id that is
 * now the old one. Retiring the old record immediately would 401 them.
 *
 * So the old record is retired *after* {@link RotationSettings.graceSeconds},
 * which `retireSession` writes as a future `revokedAt`. Requests already in
 * flight finish; a cookie replayed after the window is rejected. The window is
 * the trade, stated plainly: for that many seconds after each rotation, two ids
 * are accepted for one session.
 *
 * The same race also means several of those concurrent requests can each decide
 * to rotate. That is harmless rather than guarded against: each writes a record,
 * the browser keeps the last `Set-Cookie`, and the losers are retired by their
 * own TTL. A lock on the request path would cost every authenticated request a
 * round trip to avoid writing a few short-lived keys.
 *
 * ## Where it happens
 *
 * `server/middleware/10.auth.ts`, on the paths the access policy manages — which
 * is API traffic, not pages. A session that only ever loads pages is not
 * rotated, and is still capped: the absolute check runs in the same place, and
 * any API call the app makes reaches it.
 */

/** Where the settings live, for error messages that have to name it. */
export const ROTATION_CONFIG_PATH = 'runtimeConfig.session.rotation'

/** Rotating more often than this would put a storage write on most requests. */
const MIN_INTERVAL_SECONDS = 60

/** Long enough for in-flight requests, short enough to still be a window. */
const MIN_GRACE_SECONDS = 1
const MAX_GRACE_SECONDS = 300

/** Timestamps the sealed session carries so the two clocks above can be read. */
export interface SessionMarks {
  /** `Date.now()` at the sign-in this session descends from. Survives rotation. */
  readonly issuedAt: number
  /** `Date.now()` when the current session id was minted. Reset by rotation. */
  readonly rotatedAt: number
}

export interface RotationSettings {
  /** How old an id may get before it is replaced. `0` disables rotation. */
  readonly intervalSeconds: number
  /** How long one sign-in may last, rotations included. `0` disables the cap. */
  readonly absoluteMaxAgeSeconds: number
  /** How long the replaced id keeps working. See the grace-window note above. */
  readonly graceSeconds: number
}

/**
 * The subset of runtime config this module reads.
 *
 * `sessionRotation` is a sibling of `session` rather than a key inside it: every
 * key in `session` is passed straight to h3 as its `SessionConfig`, so putting
 * something there that h3 does not know about is borrowing a namespace that
 * belongs to another library. The environment variables come out the same
 * (`NUXT_SESSION_ROTATION_*`) either way.
 *
 * The `| string` on every number is the coercion `server/utils/storage.ts`
 * documents: a `NUXT_SESSION_ROTATION_INTERVAL_SECONDS` can arrive as `"900"`.
 */
export interface RotationRuntimeConfig {
  readonly session?: { readonly maxAge?: number | string | undefined } | undefined
  readonly sessionRotation?:
    | {
        readonly intervalSeconds?: number | string | undefined
        readonly absoluteMaxAgeSeconds?: number | string | undefined
        readonly graceSeconds?: number | string | undefined
      }
    | undefined
}

/** What the middleware should do with the session it just unsealed. */
export type RotationVerdict = 'keep' | 'rotate' | 'expired'

/** Stamps for a session being minted now — both clocks start together. */
export function freshMarks(now: number = Date.now()): SessionMarks {
  return { issuedAt: now, rotatedAt: now }
}

/**
 * A new credential id.
 *
 * `randomUUID` from `node:crypto` rather than the Web Crypto global, because
 * Nitro's `unenv` polyfill for `node:crypto` is what every preset provides and
 * `crypto.randomUUID` is not available on all of them. It is the same source h3
 * uses for its own session ids.
 */
export function newCredentialId(): string {
  return randomUUID()
}

/**
 * Reads the marks off an unsealed session.
 *
 * `UserSession` declares both as required, which is what forces every call that
 * mints a session to supply them. A cookie sealed before this existed carries
 * neither, so the declaration is a statement about new sessions rather than
 * about every byte string a browser might still be holding — hence the runtime
 * check, and hence `unknown` rather than `Partial<SessionMarks>`.
 *
 * A mark that is absent or not a finite number reads as absent, not as zero: a
 * zero `issuedAt` would put the session's sign-in in 1970 and expire it, which
 * would sign out every existing user the moment this deployed. {@link
 * rotationVerdict} treats absence as "rotate and re-stamp" instead.
 */
export function readSessionMarks(session: unknown): Partial<SessionMarks> {
  if (typeof session !== 'object' || session === null) return {}
  const candidate = session as Record<string, unknown>

  return {
    ...(isTimestamp(candidate['issuedAt']) ? { issuedAt: candidate['issuedAt'] } : {}),
    ...(isTimestamp(candidate['rotatedAt']) ? { rotatedAt: candidate['rotatedAt'] } : {}),
  }
}

/**
 * Decides what happens to a session, from its marks alone.
 *
 * The order is deliberate: the absolute cap is checked before the interval, so a
 * session that is both due for rotation and past its cap ends rather than being
 * renewed one last time.
 */
export function rotationVerdict(
  marks: Partial<SessionMarks>,
  settings: RotationSettings,
  now: number,
): RotationVerdict {
  const { issuedAt, rotatedAt } = marks

  if (
    settings.absoluteMaxAgeSeconds > 0 &&
    issuedAt !== undefined &&
    now - issuedAt >= settings.absoluteMaxAgeSeconds * 1000
  ) {
    return 'expired'
  }

  if (settings.intervalSeconds <= 0) return 'keep'

  // No mark means a session minted before this module existed, or one whose
  // marks were tampered out. Rotating adopts it onto the scheme — which also
  // gives it an `issuedAt`, so the cap starts applying to it from now.
  if (rotatedAt === undefined || issuedAt === undefined) return 'rotate'

  // `>=` rather than `>` so an interval of 0 would rotate every request if the
  // guard above ever stopped catching it, rather than never rotating.
  return now - rotatedAt >= settings.intervalSeconds * 1000 ? 'rotate' : 'keep'
}

/**
 * Turns runtime config into settings, clamping rather than throwing.
 *
 * Clamping is the house style for these (see `server/utils/idempotency.ts`), and
 * the relationships matter more than the individual values:
 *
 *  - The interval is capped at the cookie's own `maxAge`. A longer one would
 *    mean the cookie expires before it ever rotates, so rotation would be
 *    configured and dead.
 *  - The absolute cap is floored at the interval, for the same reason in the
 *    other direction: a cap below the rotation interval expires every session
 *    before its first rotation, which reads as "auth is broken" rather than as
 *    a misconfiguration.
 *  - The grace window is capped well under the interval, so two ids are never
 *    live for a meaningful share of an id's life.
 */
export function resolveRotationSettings(config: RotationRuntimeConfig): RotationSettings {
  const cookieMaxAge = toSeconds(config.session?.maxAge, 0)
  const rotation = config.sessionRotation

  const requestedInterval = toSeconds(rotation?.intervalSeconds, 0)
  const intervalSeconds =
    requestedInterval <= 0
      ? 0
      : clamp(requestedInterval, MIN_INTERVAL_SECONDS, cookieMaxAge > 0 ? cookieMaxAge : Infinity)

  const requestedAbsolute = toSeconds(rotation?.absoluteMaxAgeSeconds, 0)
  const absoluteMaxAgeSeconds =
    requestedAbsolute <= 0 ? 0 : Math.max(requestedAbsolute, intervalSeconds)

  const requestedGrace = toSeconds(rotation?.graceSeconds, MIN_GRACE_SECONDS)
  const graceCeiling =
    intervalSeconds > 0
      ? Math.max(MIN_GRACE_SECONDS, Math.min(MAX_GRACE_SECONDS, Math.floor(intervalSeconds / 4)))
      : MAX_GRACE_SECONDS
  const graceSeconds = clamp(requestedGrace, MIN_GRACE_SECONDS, graceCeiling)

  return { intervalSeconds, absoluteMaxAgeSeconds, graceSeconds }
}

/**
 * Replaces the caller's session id with a new one, keeping them signed in.
 *
 * `replaceUserSession` is what mints the id: it clears h3's in-context session
 * and writes a fresh one, so the id, the seal and the cookie's expiry are all
 * new. `setUserSession` would merge into the existing session and keep the id,
 * which is exactly what this is trying not to do.
 *
 * Returns the new session id, or `null` when nothing was rotated.
 *
 * ## Failure is not a sign-out
 *
 * Every registry write here is best-effort, the same stance
 * `session-store.ts` documents: a Redis blip during a rotation must not end the
 * session of a user who did nothing wrong. The costs of each failure are
 * different and both are logged rather than swallowed:
 *
 *  - The new record failing to write leaves a live session that cannot be
 *    revoked until its next rotation — the pre-registry behaviour, for one
 *    interval.
 *  - The old record failing to retire leaves the previous id accepted until it
 *    expires, which is the pre-rotation behaviour, for one `maxAge`.
 *
 * A failure in `replaceUserSession` itself is different in kind — the cookie was
 * never reissued — so the caller keeps the session it arrived with and the next
 * request tries again.
 */
export async function rotateCurrentSession(
  event: H3Event,
  auth: AuthenticatedRequestAuth,
  marks: Partial<SessionMarks>,
  settings: RotationSettings,
  now: number = Date.now(),
): Promise<string | null> {
  const previousSessionId = auth.sessionId
  const sessionId = newCredentialId()

  try {
    // `setUserSession`, not `replaceUserSession`: the two do the same thing here,
    // because the `clear()` inside `replaceUserSession` is undone by the reseal
    // that follows it (see the note at the top of this file), and naming the one
    // that implies a replacement would be claiming a guarantee it does not give.
    // Every field of `UserSession` is written, so nothing stale survives the merge.
    //
    // `issuedAt` is carried across deliberately: rotation renews the credential,
    // it does not re-authenticate the person, so the absolute cap keeps counting
    // from the sign-in. A session with no mark adopts `now`, which starts its cap.
    await setUserSession(event, {
      user: auth.user,
      sid: sessionId,
      issuedAt: marks.issuedAt ?? now,
      rotatedAt: now,
    })
  } catch (error) {
    console.error('[auth] session rotation failed; keeping the current session:', error)
    return null
  }

  const config = useRuntimeConfig()

  try {
    const store = useSessionStore()

    await recordSession(store, {
      userId: auth.user.id,
      sessionId,
      provider: auth.user.provider,
      maxAgeSeconds: Number(config.session.maxAge),
      now,
    })

    if (previousSessionId && previousSessionId !== sessionId) {
      await retireSession(store, auth.user.id, previousSessionId, settings.graceSeconds, now)
    }
  } catch (error) {
    console.error('[auth] session rotated but the registry could not be updated:', error)
  }

  return sessionId
}

/**
 * Ends a session that has hit the absolute cap: revoke the record, drop the
 * cookie. The caller then answers 401.
 *
 * Revocation comes first and its failure is logged rather than thrown, so the
 * cookie is cleared either way — the same ordering, and the same reasoning, as
 * `server/api/auth/logout.post.ts`.
 */
export async function endExpiredSession(
  event: H3Event,
  auth: AuthenticatedRequestAuth,
  now: number = Date.now(),
): Promise<void> {
  if (auth.sessionId) {
    try {
      await revokeSession(useSessionStore(), auth.user.id, auth.sessionId, now)
    } catch (error) {
      console.error('[auth] could not revoke a session that hit its absolute cap:', error)
    }
  }

  await clearUserSession(event)
}

/**
 * The session a sign-in writes. Kept here so both sign-in paths agree.
 *
 * The fresh `sid` is the session-fixation defence: the identifier the registry
 * and this module work from is minted at authentication, so it is never one a
 * caller was holding beforehand. h3's own id is not usable for that — it is
 * recovered from whatever cookie the request arrived with, and no API rotates
 * it.
 */
export function signInSession(user: User, now: number = Date.now()) {
  return { user, sid: newCredentialId(), ...freshMarks(now) }
}

function isTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

function toSeconds(value: number | string | undefined, fallback: number): number {
  const parsed = typeof value === 'string' ? Number(value) : value
  if (parsed === undefined || !Number.isFinite(parsed) || parsed < 0) return fallback
  return Math.floor(parsed)
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}
