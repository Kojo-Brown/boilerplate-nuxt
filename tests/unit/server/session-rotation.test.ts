import { createStorage, type Storage } from 'unstorage'
import memoryDriver from 'unstorage/drivers/memory'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { User } from '#auth-utils'

import type { AuthenticatedRequestAuth } from '~/server/utils/request-auth'
import {
  endExpiredSession,
  freshMarks,
  readSessionMarks,
  resolveRotationSettings,
  rotateCurrentSession,
  rotationVerdict,
  signInSession,
  type RotationSettings,
} from '~/server/utils/session-rotation'
import { readSessionRecord, recordSession, sessionStatus } from '~/server/utils/session-store'
import type { SessionRecord } from '~/server/utils/session-store'

const NOW = 1_800_000_000_000
const MINUTE = 60 * 1000
const WEEK_SECONDS = 60 * 60 * 24 * 7

const SETTINGS: RotationSettings = {
  intervalSeconds: 900,
  absoluteMaxAgeSeconds: WEEK_SECONDS,
  graceSeconds: 30,
}

const USER: User = {
  id: 'user-1',
  email: 'admin@example.com',
  name: 'Admin User',
  provider: 'credentials',
}

describe('freshMarks / signInSession', () => {
  it('starts both clocks together', () => {
    expect(freshMarks(NOW)).toEqual({ issuedAt: NOW, rotatedAt: NOW })
  })

  it('gives a sign-in everything UserSession requires, so the call compiles', () => {
    // The type is the test here: `setUserSession` takes `UserSession` minus its
    // id, so a sign-in path that forgets to stamp the clocks does not build.
    expect(signInSession(USER, NOW)).toMatchObject({ user: USER, issuedAt: NOW, rotatedAt: NOW })
  })
})

describe('readSessionMarks', () => {
  it('reads both marks off an unsealed session', () => {
    expect(readSessionMarks({ user: USER, issuedAt: 1, rotatedAt: 2 })).toEqual({
      issuedAt: 1,
      rotatedAt: 2,
    })
  })

  it('reports a session sealed before rotation existed as having neither', () => {
    expect(readSessionMarks({ user: USER })).toEqual({})
  })

  it('treats a non-number, a zero and a NaN as absent rather than as 1970', () => {
    // A zero `issuedAt` would put the sign-in at the epoch and expire every
    // session the moment this deployed.
    for (const value of [0, -1, 'yesterday', null, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(readSessionMarks({ issuedAt: value, rotatedAt: value })).toEqual({})
    }
  })

  it('survives a session that is not an object', () => {
    for (const value of [null, undefined, 'session', 42]) {
      expect(readSessionMarks(value)).toEqual({})
    }
  })
})

describe('rotationVerdict', () => {
  const marks = { issuedAt: NOW, rotatedAt: NOW }

  it('keeps a session that is younger than the interval', () => {
    expect(rotationVerdict(marks, SETTINGS, NOW + 14 * MINUTE)).toBe('keep')
  })

  it('rotates once the interval has elapsed', () => {
    expect(rotationVerdict(marks, SETTINGS, NOW + 15 * MINUTE)).toBe('rotate')
  })

  it('measures the interval from the last rotation, not from the sign-in', () => {
    const rotated = { issuedAt: NOW, rotatedAt: NOW + 20 * MINUTE }

    expect(rotationVerdict(rotated, SETTINGS, NOW + 30 * MINUTE)).toBe('keep')
  })

  it('expires a session that has hit the absolute cap', () => {
    expect(rotationVerdict(marks, SETTINGS, NOW + WEEK_SECONDS * 1000)).toBe('expired')
  })

  it('expires rather than rotating when both are due', () => {
    // A session past its cap must not be renewed one last time on the way out.
    const stale = { issuedAt: NOW, rotatedAt: NOW }

    expect(rotationVerdict(stale, SETTINGS, NOW + WEEK_SECONDS * 1000 + MINUTE)).toBe('expired')
  })

  it('never expires when the cap is disabled', () => {
    const uncapped = { ...SETTINGS, absoluteMaxAgeSeconds: 0 }

    expect(rotationVerdict(marks, uncapped, NOW + 10 * WEEK_SECONDS * 1000)).toBe('rotate')
  })

  it('keeps everything when rotation is disabled', () => {
    const off = { ...SETTINGS, intervalSeconds: 0 }

    expect(rotationVerdict(marks, off, NOW + 10 * MINUTE)).toBe('keep')
  })

  it('still applies the cap when rotation is disabled', () => {
    // Turning rotation off is a performance choice; it is not a way to opt out
    // of the session ever ending.
    const off = { ...SETTINGS, intervalSeconds: 0 }

    expect(rotationVerdict(marks, off, NOW + WEEK_SECONDS * 1000)).toBe('expired')
  })

  it('rotates an unmarked session so it is adopted onto the scheme', () => {
    expect(rotationVerdict({}, SETTINGS, NOW)).toBe('rotate')
    expect(rotationVerdict({ issuedAt: NOW }, SETTINGS, NOW)).toBe('rotate')
    expect(rotationVerdict({ rotatedAt: NOW }, SETTINGS, NOW)).toBe('rotate')
  })

  it('does not expire an unmarked session, which has no readable age', () => {
    // Expiring here would sign out every existing user on deploy. They are
    // rotated instead, which stamps an `issuedAt` and starts their cap.
    expect(rotationVerdict({}, SETTINGS, NOW + 10 * WEEK_SECONDS * 1000)).toBe('rotate')
  })
})

describe('resolveRotationSettings', () => {
  const base = { session: { maxAge: WEEK_SECONDS } }

  it('takes the configured values when they are sane', () => {
    expect(
      resolveRotationSettings({
        ...base,
        sessionRotation: {
          intervalSeconds: 900,
          absoluteMaxAgeSeconds: WEEK_SECONDS,
          graceSeconds: 30,
        },
      }),
    ).toEqual(SETTINGS)
  })

  it('coerces values that arrived from the environment as strings', () => {
    expect(
      resolveRotationSettings({
        session: { maxAge: String(WEEK_SECONDS) },
        sessionRotation: {
          intervalSeconds: '900',
          absoluteMaxAgeSeconds: String(WEEK_SECONDS),
          graceSeconds: '30',
        },
      }),
    ).toEqual(SETTINGS)
  })

  it('treats an interval of 0 as off rather than clamping it up', () => {
    const settings = resolveRotationSettings({ ...base, sessionRotation: { intervalSeconds: 0 } })

    expect(settings.intervalSeconds).toBe(0)
  })

  it('defaults to off when nothing is configured', () => {
    expect(resolveRotationSettings({}).intervalSeconds).toBe(0)
  })

  it('floors a too-frequent interval, so rotation is not a write on every request', () => {
    const settings = resolveRotationSettings({ ...base, sessionRotation: { intervalSeconds: 5 } })

    expect(settings.intervalSeconds).toBe(60)
  })

  it('caps the interval at the cookie lifetime, which would otherwise never rotate', () => {
    const settings = resolveRotationSettings({
      session: { maxAge: 3600 },
      sessionRotation: { intervalSeconds: 999_999 },
    })

    expect(settings.intervalSeconds).toBe(3600)
  })

  it('floors the absolute cap at the interval, so a session gets at least one rotation', () => {
    // A cap under the interval would expire every session before its first
    // rotation, which reads as "auth is broken" rather than as a typo.
    const settings = resolveRotationSettings({
      ...base,
      sessionRotation: { intervalSeconds: 900, absoluteMaxAgeSeconds: 60 },
    })

    expect(settings.absoluteMaxAgeSeconds).toBe(900)
  })

  it('leaves the cap disabled when it is configured off, whatever the interval', () => {
    const settings = resolveRotationSettings({
      ...base,
      sessionRotation: { intervalSeconds: 900, absoluteMaxAgeSeconds: 0 },
    })

    expect(settings.absoluteMaxAgeSeconds).toBe(0)
  })

  it('keeps the grace window well under the interval', () => {
    // Two ids live for a quarter of an id's life is the most this will allow.
    const settings = resolveRotationSettings({
      ...base,
      sessionRotation: { intervalSeconds: 60, graceSeconds: 600 },
    })

    expect(settings.graceSeconds).toBe(15)
  })

  it('keeps a grace window of at least a second', () => {
    const settings = resolveRotationSettings({
      ...base,
      sessionRotation: { intervalSeconds: 900, graceSeconds: 0 },
    })

    expect(settings.graceSeconds).toBe(1)
  })

  it('ignores a negative value rather than inverting a clamp', () => {
    const settings = resolveRotationSettings({
      ...base,
      sessionRotation: { intervalSeconds: -900, absoluteMaxAgeSeconds: -1, graceSeconds: -30 },
    })

    expect(settings).toEqual({ intervalSeconds: 0, absoluteMaxAgeSeconds: 0, graceSeconds: 1 })
  })
})

/**
 * The two functions that touch h3 and the registry.
 *
 * The session is a small fake rather than a mock of `replaceUserSession`: what
 * these tests are about is that the *id changes* and that the registry ends up
 * describing the new one, and a mock that recorded the call would assert neither.
 */
describe('rotateCurrentSession', () => {
  let store: Storage<SessionRecord>
  let session: Record<string, unknown>
  let writes: Record<string, unknown>[]
  let storeFails: boolean
  let writeFails: boolean
  let errors: unknown[][]

  const auth = (sessionId: string | null): AuthenticatedRequestAuth => ({
    authenticated: true,
    user: USER,
    sessionId,
  })

  beforeEach(() => {
    store = createStorage<SessionRecord>({ driver: memoryDriver() })
    session = { user: USER, sid: 'sess-old', issuedAt: NOW, rotatedAt: NOW, id: 'h3-id-fixed' }
    writes = []
    storeFails = false
    writeFails = false
    errors = []

    vi.stubGlobal('useStorage', () => {
      if (storeFails) throw new Error('redis unreachable')
      return store
    })
    vi.stubGlobal('useRuntimeConfig', () => ({ session: { maxAge: WEEK_SECONDS } }))
    vi.stubGlobal('getUserSession', async () => session)
    vi.stubGlobal('setUserSession', async (_event: unknown, data: Record<string, unknown>) => {
      if (writeFails) throw new Error('could not seal')
      writes.push(data)
      // What h3 actually does: the data is merged and `id` is recovered from the
      // cookie the request is still carrying, so it does *not* change. A fake
      // that minted a new id here would hide the reason `sid` exists.
      session = { ...session, ...data }
    })
    vi.stubGlobal('clearUserSession', async () => {
      session = {}
    })
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(args)
    })
  })

  /** The `sid` the last rotation wrote. */
  function writtenSid(index = 0): string {
    return writes[index]?.['sid'] as string
  }

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  /** A live registry record for the session the caller arrives with. */
  async function issueOld(): Promise<void> {
    await recordSession(store, {
      userId: USER.id,
      sessionId: 'sess-old',
      provider: 'credentials',
      maxAgeSeconds: WEEK_SECONDS,
      now: NOW,
    })
  }

  const event = {} as never

  it('mints a new credential id, which h3 would not have done for it', async () => {
    const id = await rotateCurrentSession(event, auth('sess-old'), { issuedAt: NOW }, SETTINGS, NOW)

    expect(id).not.toBe('sess-old')
    expect(id).toBe(writtenSid())
    // The one that cannot change, and the reason `sid` is carried at all.
    expect(session['id']).toBe('h3-id-fixed')
  })

  it('mints a different id every time', async () => {
    await rotateCurrentSession(event, auth('sess-old'), {}, SETTINGS, NOW)
    await rotateCurrentSession(event, auth(writtenSid()), {}, SETTINGS, NOW)

    expect(writtenSid(0)).not.toBe(writtenSid(1))
  })

  it('carries issuedAt across, so the absolute cap still counts from the sign-in', () => {
    const signedInAt = NOW - 3 * 24 * 60 * 60 * 1000

    return rotateCurrentSession(
      event,
      auth('sess-old'),
      { issuedAt: signedInAt, rotatedAt: NOW - MINUTE },
      SETTINGS,
      NOW,
    ).then(() => {
      expect(writes[0]).toMatchObject({ user: USER, issuedAt: signedInAt, rotatedAt: NOW })
    })
  })

  it('stamps an issuedAt on a session that arrived without one', async () => {
    await rotateCurrentSession(event, auth('sess-old'), {}, SETTINGS, NOW)

    expect(writes[0]).toMatchObject({ issuedAt: NOW, rotatedAt: NOW })
  })

  it('registers the new id, so the new session is revocable', async () => {
    const id = await rotateCurrentSession(event, auth('sess-old'), { issuedAt: NOW }, SETTINGS, NOW)

    expect(sessionStatus(await readSessionRecord(store, USER.id, id as string), NOW)).toBe('active')
  })

  it('leaves the old id working for the grace window, then stops', async () => {
    // The race this exists for: a page fires four requests at once, one rotates,
    // and the other three are already in flight with the id that just retired.
    await issueOld()
    await rotateCurrentSession(event, auth('sess-old'), { issuedAt: NOW }, SETTINGS, NOW)

    const old = await readSessionRecord(store, USER.id, 'sess-old')
    expect(sessionStatus(old, NOW + 29_000)).toBe('active')
    expect(sessionStatus(old, NOW + 31_000)).toBe('revoked')
  })

  it('keeps the session when the cookie could not be resealed', async () => {
    writeFails = true

    expect(await rotateCurrentSession(event, auth('sess-old'), {}, SETTINGS, NOW)).toBeNull()
    expect(session['sid']).toBe('sess-old')
    expect(errors).toHaveLength(1)
  })

  it('does not sign anyone out when the registry is unreachable', async () => {
    // A Redis blip during a rotation must not end the session of a user who did
    // nothing wrong. The cost is logged instead: this id is unrevocable until
    // its next rotation.
    storeFails = true
    const id = await rotateCurrentSession(event, auth('sess-old'), {}, SETTINGS, NOW)

    expect(id).toBe(writtenSid())
    expect(errors).toHaveLength(1)
  })

  it('registers the new session even when there was no old id to retire', async () => {
    const id = await rotateCurrentSession(event, auth(null), {}, SETTINGS, NOW)

    expect(await readSessionRecord(store, USER.id, id as string)).not.toBeNull()
  })
})

describe('endExpiredSession', () => {
  let store: Storage<SessionRecord>
  let cleared: number

  beforeEach(() => {
    store = createStorage<SessionRecord>({ driver: memoryDriver() })
    cleared = 0
    vi.stubGlobal('useStorage', () => store)
    vi.stubGlobal('clearUserSession', async () => {
      cleared++
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const auth: AuthenticatedRequestAuth = { authenticated: true, user: USER, sessionId: 'sess-1' }

  it('revokes the record and drops the cookie', async () => {
    await recordSession(store, {
      userId: USER.id,
      sessionId: 'sess-1',
      provider: 'credentials',
      maxAgeSeconds: WEEK_SECONDS,
      now: NOW,
    })

    await endExpiredSession({} as never, auth, NOW + MINUTE)

    expect(sessionStatus(await readSessionRecord(store, USER.id, 'sess-1'), NOW + MINUTE)).toBe(
      'revoked',
    )
    expect(cleared).toBe(1)
  })

  it('still drops the cookie when there is no record to revoke', async () => {
    await endExpiredSession({} as never, { ...auth, sessionId: null }, NOW)

    expect(cleared).toBe(1)
  })
})
