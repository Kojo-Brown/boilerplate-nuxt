import type { H3Event } from 'h3'
import { createStorage, type Storage } from 'unstorage'
import memoryDriver from 'unstorage/drivers/memory'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

import {
  readSessionRecord,
  recordSession,
  registerCurrentSession,
  revokeAllSessionsForUser,
  revokeSession,
  sessionStatus,
  sessionStoreKey,
  userKeyPrefix,
  type SessionRecord,
} from '~/server/utils/session-store'

/**
 * A real `unstorage` instance on the memory driver, not a mock.
 *
 * The registry's behaviour is mostly about what happens to stored values — a
 * revocation that preserves the record, a prefix scan that finds one user's keys
 * and not another's — and a mock would let all of that pass by returning
 * whatever the test expected. The memory driver is the same `Storage` interface
 * the Redis driver implements, so these tests exercise the real code path.
 *
 * What it cannot exercise is expiry: the memory driver ignores `ttl`. That is
 * asserted on through `expiresAt`, which the record carries itself, rather than
 * by waiting for a key to vanish.
 */
const HOUR_SECONDS = 3600
const NOW = 1_800_000_000_000

let store: Storage<SessionRecord>

beforeEach(() => {
  store = createStorage<SessionRecord>({ driver: memoryDriver() })
})

async function issue(userId: string, sessionId: string, now = NOW): Promise<SessionRecord> {
  return recordSession(store, {
    userId,
    sessionId,
    provider: 'credentials',
    maxAgeSeconds: HOUR_SECONDS,
    now,
  })
}

describe('sessionStoreKey', () => {
  it('puts the user id first, so one user is a prefix scan', () => {
    expect(sessionStoreKey('user-1', 'sess-1')).toBe('user-1:sess-1')
    expect(sessionStoreKey('user-1', 'sess-1').startsWith(userKeyPrefix('user-1'))).toBe(true)
  })

  it('encodes a colon in either half so a key cannot forge another namespace', () => {
    // Without encoding, user `a` with session `b:c` and user `a:b` with session
    // `c` would both key to `a:b:c`, and revoking one would revoke the other.
    expect(sessionStoreKey('a', 'b:c')).not.toBe(sessionStoreKey('a:b', 'c'))
  })

  it('does not let a user id smuggle a separator into the prefix scan', () => {
    expect(userKeyPrefix('user-1:extra')).not.toContain(':')
  })
})

describe('sessionStatus', () => {
  it('reports an absent record as unknown, not denied', () => {
    // Fail-open. See the module comment: fail-closed would make a Redis outage
    // sign out every user at once.
    expect(sessionStatus(null, NOW)).toBe('unknown')
    expect(sessionStatus(undefined, NOW)).toBe('unknown')
  })

  it('reports a live record as active', async () => {
    expect(sessionStatus(await issue('user-1', 'sess-1'), NOW)).toBe('active')
  })

  it('reports a revoked record as revoked', async () => {
    await issue('user-1', 'sess-1')
    await revokeSession(store, 'user-1', 'sess-1', NOW)

    expect(sessionStatus(await readSessionRecord(store, 'user-1', 'sess-1'), NOW)).toBe('revoked')
  })

  it('reports a record past its expiry as expired', async () => {
    const record = await issue('user-1', 'sess-1')

    expect(sessionStatus(record, record.expiresAt)).toBe('expired')
    expect(sessionStatus(record, record.expiresAt + 1)).toBe('expired')
  })

  it('prefers revoked over expired, so a tombstone is never read as a miss', async () => {
    await issue('user-1', 'sess-1')
    await revokeSession(store, 'user-1', 'sess-1', NOW)
    const record = await readSessionRecord(store, 'user-1', 'sess-1')

    expect(sessionStatus(record, NOW + HOUR_SECONDS * 1000 * 2)).toBe('revoked')
  })
})

describe('recordSession', () => {
  it('stores a live record whose expiry matches the cookie lifetime', async () => {
    const record = await issue('user-1', 'sess-1')

    expect(record).toEqual({
      userId: 'user-1',
      provider: 'credentials',
      createdAt: NOW,
      expiresAt: NOW + HOUR_SECONDS * 1000,
      revokedAt: null,
    })
  })

  it('is readable back through readSessionRecord', async () => {
    const written = await issue('user-1', 'sess-1')

    expect(await readSessionRecord(store, 'user-1', 'sess-1')).toEqual(written)
  })

  it('keeps one record per session, not per sign-in attempt', async () => {
    await issue('user-1', 'sess-1')
    await issue('user-1', 'sess-1', NOW + 1000)

    expect(await store.getKeys(userKeyPrefix('user-1'))).toHaveLength(1)
  })
})

describe('readSessionRecord', () => {
  it('returns null for a session it has never seen', async () => {
    expect(await readSessionRecord(store, 'user-1', 'sess-unknown')).toBeNull()
  })

  it('returns null rather than throwing on a value that is not a record', async () => {
    // A base shared with something else, or a hand-edited key, should read as
    // "unknown session" — the auth middleware must not crash on it.
    await store.setItem(sessionStoreKey('user-1', 'sess-1'), 'not-a-record' as never)

    expect(await readSessionRecord(store, 'user-1', 'sess-1')).toBeNull()
  })

  it('returns null for a record missing the fields the middleware reads', async () => {
    await store.setItem(sessionStoreKey('user-1', 'sess-1'), { userId: 'user-1' } as never)

    expect(await readSessionRecord(store, 'user-1', 'sess-1')).toBeNull()
  })
})

describe('revokeSession', () => {
  it('marks the record revoked instead of deleting it', async () => {
    // Deleting would make a revoked session indistinguishable from an unknown
    // one, and `unknown` is allowed through.
    await issue('user-1', 'sess-1')
    expect(await revokeSession(store, 'user-1', 'sess-1', NOW + 5)).toBe(true)

    expect(await readSessionRecord(store, 'user-1', 'sess-1')).toMatchObject({
      revokedAt: NOW + 5,
      userId: 'user-1',
    })
  })

  it('preserves the rest of the record', async () => {
    const issued = await issue('user-1', 'sess-1')
    await revokeSession(store, 'user-1', 'sess-1', NOW + 5)
    const revoked = await readSessionRecord(store, 'user-1', 'sess-1')

    expect(revoked).toMatchObject({
      createdAt: issued.createdAt,
      expiresAt: issued.expiresAt,
      provider: issued.provider,
    })
  })

  it('reports false for a session it has no record of', async () => {
    expect(await revokeSession(store, 'user-1', 'sess-unknown', NOW)).toBe(false)
  })

  it('reports false for an already-revoked session and leaves the timestamp alone', async () => {
    await issue('user-1', 'sess-1')
    await revokeSession(store, 'user-1', 'sess-1', NOW + 5)

    expect(await revokeSession(store, 'user-1', 'sess-1', NOW + 99)).toBe(false)
    expect(await readSessionRecord(store, 'user-1', 'sess-1')).toMatchObject({ revokedAt: NOW + 5 })
  })

  it('reports false for a session that has already expired', async () => {
    const record = await issue('user-1', 'sess-1')

    expect(await revokeSession(store, 'user-1', 'sess-1', record.expiresAt + 1)).toBe(false)
  })

  it('does not revoke another user who happens to share the session id', async () => {
    await issue('user-1', 'shared-id')
    await issue('user-2', 'shared-id')
    await revokeSession(store, 'user-1', 'shared-id', NOW)

    expect(sessionStatus(await readSessionRecord(store, 'user-2', 'shared-id'), NOW)).toBe('active')
  })
})

describe('revokeAllSessionsForUser', () => {
  it('revokes every live session that user has', async () => {
    await issue('user-1', 'laptop')
    await issue('user-1', 'phone')
    await issue('user-1', 'tablet')

    expect(await revokeAllSessionsForUser(store, 'user-1', NOW)).toBe(3)

    for (const id of ['laptop', 'phone', 'tablet']) {
      expect(sessionStatus(await readSessionRecord(store, 'user-1', id), NOW)).toBe('revoked')
    }
  })

  it('leaves other users alone', async () => {
    await issue('user-1', 'laptop')
    await issue('user-2', 'laptop')

    await revokeAllSessionsForUser(store, 'user-1', NOW)

    expect(sessionStatus(await readSessionRecord(store, 'user-2', 'laptop'), NOW)).toBe('active')
  })

  it('does not spill into a user whose id merely starts with the same characters', async () => {
    // `getKeys('user-1')` is a prefix scan; without the `:` separator being part
    // of every key, `user-10` would be caught by a scan for `user-1`.
    await issue('user-1', 'laptop')
    await issue('user-10', 'laptop')

    expect(await revokeAllSessionsForUser(store, 'user-1', NOW)).toBe(1)
    expect(sessionStatus(await readSessionRecord(store, 'user-10', 'laptop'), NOW)).toBe('active')
  })

  it('counts only what it actually revoked', async () => {
    await issue('user-1', 'laptop')
    await issue('user-1', 'phone')
    await revokeSession(store, 'user-1', 'phone', NOW)

    expect(await revokeAllSessionsForUser(store, 'user-1', NOW)).toBe(1)
  })

  it('returns 0 for a user with no sessions', async () => {
    expect(await revokeAllSessionsForUser(store, 'user-nobody', NOW)).toBe(0)
  })

  it('skips a stored value that is not a record instead of throwing', async () => {
    await issue('user-1', 'laptop')
    await store.setItem(sessionStoreKey('user-1', 'junk'), 'not-a-record' as never)

    expect(await revokeAllSessionsForUser(store, 'user-1', NOW)).toBe(1)
  })
})

describe('registerCurrentSession', () => {
  /** Whatever `getUserSession()` should return for the session just issued. */
  let issued: { id?: string } = {}
  const user = {
    id: 'user-1',
    email: 'alice@example.com',
    name: 'Alice',
    provider: 'credentials' as const,
  }

  /** The two sign-in handlers only ever pass the event through; it is unused. */
  const event = {} as H3Event

  beforeEach(() => {
    issued = { id: 'sess-1' }
    vi.stubGlobal('getUserSession', async () => issued)
    vi.stubGlobal('useStorage', () => store)
    vi.stubGlobal('useRuntimeConfig', () => ({ session: { maxAge: HOUR_SECONDS } }))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('writes the record for the session that was just issued', async () => {
    await registerCurrentSession(event, user)

    expect(await readSessionRecord(store, 'user-1', 'sess-1')).toMatchObject({
      userId: 'user-1',
      provider: 'credentials',
      revokedAt: null,
    })
  })

  it('takes the record lifetime from the session cookie config', async () => {
    // A record that outlived its cookie would be a leak; one that died early
    // would make a live session read as unknown.
    await registerCurrentSession(event, user)
    const record = await readSessionRecord(store, 'user-1', 'sess-1')

    expect(record!.expiresAt - record!.createdAt).toBe(HOUR_SECONDS * 1000)
  })

  it('coerces a session maxAge that arrived from the environment as a string', async () => {
    vi.stubGlobal('useRuntimeConfig', () => ({ session: { maxAge: '3600' } }))
    await registerCurrentSession(event, user)
    const record = await readSessionRecord(store, 'user-1', 'sess-1')

    expect(record!.expiresAt - record!.createdAt).toBe(3600 * 1000)
  })

  it('writes nothing when the session carries no id', async () => {
    issued = {}
    await registerCurrentSession(event, user)

    expect(await store.getKeys()).toEqual([])
  })

  it('does not fail the sign-in when the store is unreachable', async () => {
    // Losing revocability is bad; refusing to let anyone log in is worse. The
    // failure is logged rather than thrown — see the module comment.
    vi.stubGlobal('useStorage', () => {
      throw new Error('redis unreachable')
    })
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})

    await expect(registerCurrentSession(event, user)).resolves.toBeUndefined()
    expect(errors).toHaveBeenCalledOnce()
    errors.mockRestore()
  })
})
