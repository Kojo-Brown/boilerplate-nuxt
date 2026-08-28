import type { H3Event } from 'h3'
import type { Storage } from 'unstorage'
import type { User } from '#auth-utils'

import { SESSIONS_BASE } from '~/server/utils/storage'

/**
 * The server-side session registry, on the `sessions` storage base.
 *
 * ## What it adds, and what it deliberately does not
 *
 * `nuxt-auth-utils` sessions are **sealed cookies**. The whole session lives in
 * the browser, signed and encrypted with `NUXT_SESSION_PASSWORD`; the server
 * keeps nothing. That is why this app scales to N instances with no shared state
 * — and it is also why, before this registry, there was no way to end a session
 * early. Deleting the cookie is a request to the browser. A copy of the cookie
 * taken beforehand keeps working until `maxAge` runs out, and nothing on the
 * server can say otherwise.
 *
 * This registry is the "otherwise": one record per live session, keyed by user,
 * carrying a `revokedAt` that `server/middleware/10.auth.ts` checks. It is what
 * makes "sign out of all devices" mean something.
 *
 * It is **not** a second source of truth for who you are. `request-auth.ts` says
 * the cookie is the only thing that grants access, and that stays true: the
 * record holds no identity the cookie does not already carry, and a request is
 * never *admitted* because a record exists.
 *
 * ## Missing means unknown, not denied
 *
 * {@link sessionStatus} treats an absent record as `unknown`, and the middleware
 * lets `unknown` through. That is fail-open, and it is a deliberate trade:
 *
 * - Fail-closed would make Redis a hard dependency of *authentication*. A Redis
 *   outage would not degrade the app, it would sign out every user at once, and
 *   the fix would be unreachable because the operator is signed out too.
 * - Fail-closed would also invalidate every session issued before this registry
 *   existed, and every session issued while `NUXT_REDIS_URL` was unset.
 * - Fail-open costs exactly what the app had yesterday: a stolen cookie is valid
 *   until it expires. Revocation is a new capability on top, not a gate that was
 *   working and is now leaky.
 *
 * The honest limit that follows: revocation is only durable when the `sessions`
 * base is durable. On the per-process default driver a restart forgets every
 * `revokedAt`, and a revoked cookie works again. `docs/nitro-storage.md` says so
 * next to the deployment checklist.
 *
 * ## Keys
 *
 * `<userId>:<sessionId>`, both percent-encoded so a `:` in either cannot forge a
 * key in another user's namespace. The user id leads because that is the lookup
 * the registry has to support that a plain session-id key cannot: revoking every
 * session for one user is a prefix scan (`getKeys(userId)`), not a scan of every
 * session in the store.
 */

/** One live (or recently revoked) session. */
export interface SessionRecord {
  /** `User['id']` — the same value the sealed cookie carries. */
  readonly userId: string
  /** `User['provider']`, so a device list can say how the session was created. */
  readonly provider: string
  /** `Date.now()` when the session was issued. */
  readonly createdAt: number
  /** `Date.now()` when the cookie expires. The record's TTL matches it. */
  readonly expiresAt: number
  /** `Date.now()` when the session was revoked, or `null` while it is live. */
  readonly revokedAt: number | null
}

export type SessionStatus = 'unknown' | 'active' | 'revoked' | 'expired'

export interface RecordSessionInput {
  readonly userId: string
  readonly sessionId: string
  readonly provider: string
  /** Session lifetime in seconds — `runtimeConfig.session.maxAge`. */
  readonly maxAgeSeconds: number
  /** Injected so tests do not depend on the wall clock. */
  readonly now?: number
}

/**
 * The `sessions` base of Nitro's storage.
 *
 * `useStorage` is a Nitro auto-import, so this is the seam where the rest of the
 * module stops depending on Nitro: every function below takes a `Storage` and
 * can be handed a real in-memory one in a test.
 */
export function useSessionStore(): Storage<SessionRecord> {
  return useStorage<SessionRecord>(SESSIONS_BASE)
}

/** `<userId>:<sessionId>`, encoded so neither part can escape its segment. */
export function sessionStoreKey(userId: string, sessionId: string): string {
  return `${encodeURIComponent(userId)}:${encodeURIComponent(sessionId)}`
}

/** The prefix every key for one user shares — the argument to `getKeys()`. */
export function userKeyPrefix(userId: string): string {
  return encodeURIComponent(userId)
}

/**
 * Classifies a record. The middleware rejects `revoked` and nothing else — see
 * the fail-open note above for why `unknown` is not a rejection, and note that
 * `expired` is not one either: the cookie carries the same expiry, so an expired
 * record describes a cookie the browser has already stopped sending.
 */
export function sessionStatus(
  record: SessionRecord | null | undefined,
  now: number,
): SessionStatus {
  if (!record) return 'unknown'
  if (record.revokedAt !== null) return 'revoked'
  if (record.expiresAt <= now) return 'expired'
  return 'active'
}

/** Writes the record for a session that has just been issued. */
export async function recordSession(
  store: Storage<SessionRecord>,
  input: RecordSessionInput,
): Promise<SessionRecord> {
  const now = input.now ?? Date.now()
  const record: SessionRecord = {
    userId: input.userId,
    provider: input.provider,
    createdAt: now,
    expiresAt: now + input.maxAgeSeconds * 1000,
    revokedAt: null,
  }

  // The per-item `ttl` is what the Redis driver turns into `EX`. The mount in
  // `server/utils/storage.ts` sets the same value as a driver default, so the
  // record expires with the cookie under either. Drivers without expiry support
  // (the per-process default) ignore it, which is the limitation documented above.
  await store.setItem(sessionStoreKey(input.userId, input.sessionId), record, {
    ttl: input.maxAgeSeconds,
  })

  return record
}

/**
 * Reads one record. Returns `null` for a miss, and for a stored value that is
 * not a record — a base shared with something else, or a hand-edited key, should
 * read as "unknown session", not crash the auth middleware.
 */
export async function readSessionRecord(
  store: Storage<SessionRecord>,
  userId: string,
  sessionId: string,
): Promise<SessionRecord | null> {
  const raw = await store.getItem(sessionStoreKey(userId, sessionId))
  return isSessionRecord(raw) ? raw : null
}

/**
 * Marks one session revoked, keeping the record so the middleware can tell
 * "revoked" from "never seen". Returns whether there was a live record to
 * revoke; `false` means the session was unknown, already revoked, or expired.
 */
export async function revokeSession(
  store: Storage<SessionRecord>,
  userId: string,
  sessionId: string,
  now: number = Date.now(),
): Promise<boolean> {
  const record = await readSessionRecord(store, userId, sessionId)
  if (sessionStatus(record, now) !== 'active') return false

  await writeRevocation(store, sessionStoreKey(userId, sessionId), record as SessionRecord, now)
  return true
}

/**
 * Revokes every live session for one user — "sign out everywhere".
 *
 * Walks the user's own key prefix rather than the whole base, so the cost is the
 * number of sessions that user has, not the number in the store. On Redis that
 * is a `SCAN` with a `MATCH`, which is why this is a deliberate user action and
 * not something on the request path.
 *
 * Returns how many were revoked.
 */
export async function revokeAllSessionsForUser(
  store: Storage<SessionRecord>,
  userId: string,
  now: number = Date.now(),
): Promise<number> {
  const keys = await store.getKeys(userKeyPrefix(userId))
  let revoked = 0

  for (const key of keys) {
    const raw = await store.getItem(key)
    if (!isSessionRecord(raw) || sessionStatus(raw, now) !== 'active') continue
    await writeRevocation(store, key, raw, now)
    revoked++
  }

  return revoked
}

/**
 * Rewrites a record with `revokedAt` set, preserving the remaining lifetime.
 *
 * Re-deriving the TTL from `expiresAt` matters: `setItem` on Redis issues a
 * `SET`, which drops any expiry the key already had. Without this the tombstone
 * would inherit the mount's default TTL — a *longer* one than the session had
 * left — and revoked records would outlive the cookies they describe.
 */
async function writeRevocation(
  store: Storage<SessionRecord>,
  key: string,
  record: SessionRecord,
  now: number,
): Promise<void> {
  const remainingSeconds = Math.max(1, Math.ceil((record.expiresAt - now) / 1000))
  await store.setItem(key, { ...record, revokedAt: now }, { ttl: remainingSeconds })
}

/**
 * Registers the session the caller has *just* been given — the one line both
 * sign-in paths (`api/auth/login.post.ts` and `routes/auth/github.get.ts`) run
 * after `setUserSession`.
 *
 * It re-reads the session rather than taking an id as an argument because the id
 * is minted by h3 inside `setUserSession`; reading it back is the only way to
 * learn it. A session with no id is skipped rather than treated as an error: the
 * registry is an enhancement, and failing a login over it would be the wrong
 * trade in the same direction as every other decision in this file.
 *
 * Errors are swallowed for the same reason — with a note, because a sign-in that
 * silently goes unregistered is a session that silently cannot be revoked.
 */
export async function registerCurrentSession(event: H3Event, user: User): Promise<void> {
  try {
    const session = await getUserSession(event)
    if (!session.id) return

    const config = useRuntimeConfig()
    await recordSession(useSessionStore(), {
      userId: user.id,
      sessionId: session.id,
      provider: user.provider,
      maxAgeSeconds: Number(config.session.maxAge),
    })
  } catch (error) {
    console.error('[auth] could not register session; it will not be revocable:', error)
  }
}

function isSessionRecord(value: unknown): value is SessionRecord {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<SessionRecord>
  return (
    typeof candidate.userId === 'string' &&
    typeof candidate.provider === 'string' &&
    typeof candidate.createdAt === 'number' &&
    typeof candidate.expiresAt === 'number' &&
    (candidate.revokedAt === null || typeof candidate.revokedAt === 'number')
  )
}
