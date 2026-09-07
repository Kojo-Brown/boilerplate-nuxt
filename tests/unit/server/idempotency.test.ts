import { createStorage, type Storage } from 'unstorage'
import memoryDriver from 'unstorage/drivers/memory'
import { describe, it, expect, beforeEach } from 'vitest'

import {
  DEFAULT_CLAIM_TIMEOUT_SECONDS,
  DEFAULT_RETENTION_SECONDS,
  MAX_CLAIM_TIMEOUT_SECONDS,
  MAX_RETENTION_SECONDS,
  MIN_CLAIM_TIMEOUT_SECONDS,
  MIN_RETENTION_SECONDS,
  claimIdempotency,
  completeIdempotency,
  fingerprintRequest,
  idempotencyScopePrefix,
  idempotencyStoreKey,
  isReplayableStatus,
  isValidIdempotencyKey,
  releaseIdempotencyClaim,
  resolveIdempotencySettings,
  type IdempotencyRecord,
  type IdempotencySettings,
  type StoredResponse,
} from '~/server/utils/idempotency'

/**
 * A real `unstorage` on the memory driver, not a mock.
 *
 * Everything interesting here is about what a *second* call sees after a first
 * one wrote — a claim that has to be visible to the read-back, a completed
 * record that has to survive to be replayed, a release that has to actually
 * remove a key. A mock returning whatever the test expected would let all of it
 * pass without the module doing any of it.
 *
 * What the memory driver cannot exercise is expiry: it accepts `ttl` and ignores
 * it. So the claim timeout is asserted through the injected clock, which is the
 * mechanism the module actually uses, and record expiry is left to the driver.
 */
const NOW = 1_800_000_000_000

const SETTINGS: IdempotencySettings = {
  retentionSeconds: DEFAULT_RETENTION_SECONDS,
  claimTimeoutSeconds: DEFAULT_CLAIM_TIMEOUT_SECONDS,
}

const RESPONSE: StoredResponse = { status: 201, body: '{"data":{"id":"t1"}}' }

let store: Storage<IdempotencyRecord>

beforeEach(() => {
  store = createStorage<IdempotencyRecord>({ driver: memoryDriver() })
})

async function claim(key: string, fingerprint: string, claimToken: string, now = NOW) {
  return claimIdempotency(store, { key, fingerprint, claimToken, settings: SETTINGS, now })
}

describe('isValidIdempotencyKey', () => {
  it('accepts the shapes a client actually sends', () => {
    expect(isValidIdempotencyKey(crypto.randomUUID())).toBe(true)
    expect(isValidIdempotencyKey('01JKQ8Z9WKMR6T4Y2N3PQXV7AB')).toBe(true)
    expect(isValidIdempotencyKey('order-2026-09-07_v2')).toBe(true)
  })

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['an empty string', ''],
    ['a key short enough to collide by accident', '1'],
    ['a key with a space', 'order 1234'],
    ['a key with a CRLF, which would forge a log line', 'order\r\n1234'],
    ['a key with a colon, which is the store-key separator', 'order:1234'],
    ['a 129-character key', 'a'.repeat(129)],
  ])('rejects %s', (_label, value) => {
    expect(isValidIdempotencyKey(value)).toBe(false)
  })

  it('accepts exactly 8 and exactly 128 characters', () => {
    expect(isValidIdempotencyKey('a'.repeat(8))).toBe(true)
    expect(isValidIdempotencyKey('a'.repeat(128))).toBe(true)
    expect(isValidIdempotencyKey('a'.repeat(7))).toBe(false)
  })
})

describe('idempotencyStoreKey', () => {
  it('puts the scope first, so one caller is a prefix scan', () => {
    const key = idempotencyStoreKey('user-1', 'key-abcd')

    expect(key).toBe('user-1:key-abcd')
    expect(key.startsWith(idempotencyScopePrefix('user-1'))).toBe(true)
  })

  it('encodes a colon in either half so a key cannot forge another scope', () => {
    // Without encoding, user `a` with key `b:c` and user `a:b` with key `c`
    // would both address `a:b:c` — one caller replaying another's response,
    // which is the one failure this layout exists to make impossible.
    expect(idempotencyStoreKey('a', 'b:c')).not.toBe(idempotencyStoreKey('a:b', 'c'))
  })
})

describe('isReplayableStatus', () => {
  it.each([200, 201, 204, 299])('replays %i', (status) => {
    expect(isReplayableStatus(status)).toBe(true)
  })

  it.each([301, 400, 404, 422, 500, 503])('does not replay %i', (status) => {
    expect(isReplayableStatus(status)).toBe(false)
  })
})

describe('fingerprintRequest', () => {
  const body = new TextEncoder().encode('{"title":"buy milk"}')

  it('is stable for the same request', async () => {
    const a = await fingerprintRequest({ method: 'POST', path: '/api/todos', body })
    const b = await fingerprintRequest({ method: 'POST', path: '/api/todos', body })

    expect(a).toBe(b)
    expect(a).toMatch(/^[0-9a-f]{64}$/)
  })

  it('changes when the body changes', async () => {
    const a = await fingerprintRequest({ method: 'POST', path: '/api/todos', body })
    const b = await fingerprintRequest({
      method: 'POST',
      path: '/api/todos',
      body: new TextEncoder().encode('{"title":"buy bread"}'),
    })

    expect(a).not.toBe(b)
  })

  it('changes when the method or the path changes, because a key names one operation', async () => {
    const post = await fingerprintRequest({ method: 'POST', path: '/api/todos', body })
    const patch = await fingerprintRequest({ method: 'PATCH', path: '/api/todos', body })
    const other = await fingerprintRequest({ method: 'POST', path: '/api/todos/1', body })

    expect(new Set([post, patch, other]).size).toBe(3)
  })

  it('folds in the query string, since it is part of the request target', async () => {
    const a = await fingerprintRequest({ method: 'POST', path: '/api/todos?dry=1' })
    const b = await fingerprintRequest({ method: 'POST', path: '/api/todos?dry=0' })

    expect(a).not.toBe(b)
  })

  it('treats a missing body and an empty body as the same request', async () => {
    const absent = await fingerprintRequest({ method: 'DELETE', path: '/api/todos/1' })
    const empty = await fingerprintRequest({
      method: 'DELETE',
      path: '/api/todos/1',
      body: new Uint8Array(0),
    })

    expect(absent).toBe(empty)
  })

  it('is case-insensitive on the method, which HTTP is not consistent about', async () => {
    const upper = await fingerprintRequest({ method: 'POST', path: '/api/todos', body })
    const lower = await fingerprintRequest({ method: 'post', path: '/api/todos', body })

    expect(upper).toBe(lower)
  })

  it('cannot be fooled by moving the field boundary', async () => {
    // The framing has to be injective or two different requests share a record.
    // Without a separator, method `POST` + path `/a` and method `POS` + path
    // `T/a` would hash the same bytes.
    const a = await fingerprintRequest({ method: 'POST', path: '/a' })
    const b = await fingerprintRequest({ method: 'POS', path: 'T/a' })

    expect(a).not.toBe(b)
  })
})

describe('resolveIdempotencySettings', () => {
  it('falls back to the defaults with no config at all', () => {
    expect(resolveIdempotencySettings({})).toEqual({
      retentionSeconds: DEFAULT_RETENTION_SECONDS,
      claimTimeoutSeconds: DEFAULT_CLAIM_TIMEOUT_SECONDS,
    })
  })

  it('parses the strings a NUXT_* environment override arrives as', () => {
    // The failure this prevents: NUXT_IDEMPOTENCY_RETENTION_SECONDS=3600
    // reaching the Redis driver as the string "3600", which is not a TTL.
    const settings = resolveIdempotencySettings({
      idempotency: { retentionSeconds: '3600', claimTimeoutSeconds: '30' },
    })

    expect(settings).toEqual({ retentionSeconds: 3600, claimTimeoutSeconds: 30 })
  })

  it('clamps rather than throws, because both are operational dials', () => {
    const low = resolveIdempotencySettings({
      idempotency: { retentionSeconds: 1, claimTimeoutSeconds: 1 },
    })
    const high = resolveIdempotencySettings({
      idempotency: { retentionSeconds: 99_999_999, claimTimeoutSeconds: 99_999 },
    })

    expect(low).toEqual({
      retentionSeconds: MIN_RETENTION_SECONDS,
      claimTimeoutSeconds: MIN_CLAIM_TIMEOUT_SECONDS,
    })
    expect(high).toEqual({
      retentionSeconds: MAX_RETENTION_SECONDS,
      claimTimeoutSeconds: MAX_CLAIM_TIMEOUT_SECONDS,
    })
  })

  it.each([
    ['an empty string', ''],
    ['a non-numeric string', 'soon'],
    ['zero', 0],
    ['a negative', -60],
    ['NaN', Number.NaN],
  ])('falls back on %s rather than clamping it to the floor', (_label, value) => {
    const settings = resolveIdempotencySettings({ idempotency: { retentionSeconds: value } })

    expect(settings.retentionSeconds).toBe(DEFAULT_RETENTION_SECONDS)
  })
})

describe('claimIdempotency', () => {
  it('lets an unseen key proceed, and records the claim', async () => {
    const decision = await claim('user-1:key-abcd', 'fp-1', 'token-1')

    expect(decision).toEqual({ outcome: 'proceed', claimToken: 'token-1' })
    expect(await store.getItem('user-1:key-abcd')).toMatchObject({
      state: 'in-flight',
      claimToken: 'token-1',
      fingerprint: 'fp-1',
    })
  })

  it('carries the fingerprint on the claim, not only on completion', async () => {
    // So two different payloads sent concurrently under one key give one 422 and
    // one execution, rather than two executions that only disagree afterwards.
    await claim('k', 'fp-1', 'token-1')

    expect(await claim('k', 'fp-2', 'token-2')).toEqual({ outcome: 'fingerprint-mismatch' })
  })

  it('reports a live claim as in-flight rather than running the handler twice', async () => {
    await claim('k', 'fp-1', 'token-1')

    expect(await claim('k', 'fp-1', 'token-2')).toEqual({ outcome: 'in-flight' })
  })

  it('replays a completed record', async () => {
    await claim('k', 'fp-1', 'token-1')
    await completeIdempotency(store, {
      key: 'k',
      claimToken: 'token-1',
      fingerprint: 'fp-1',
      response: RESPONSE,
      settings: SETTINGS,
      now: NOW,
    })

    expect(await claim('k', 'fp-1', 'token-2')).toEqual({ outcome: 'replay', response: RESPONSE })
  })

  it('refuses a completed record replayed with a different payload', async () => {
    await claim('k', 'fp-1', 'token-1')
    await completeIdempotency(store, {
      key: 'k',
      claimToken: 'token-1',
      fingerprint: 'fp-1',
      response: RESPONSE,
      settings: SETTINGS,
      now: NOW,
    })

    // The dangerous alternative is answering the second request with the first
    // one's response — the client's write silently never happens.
    expect(await claim('k', 'fp-2', 'token-2')).toEqual({ outcome: 'fingerprint-mismatch' })
  })

  it('checks the fingerprint before the state, so a mismatch is never a replay', async () => {
    await claim('k', 'fp-1', 'token-1')

    const inFlight = await claim('k', 'fp-2', 'token-2')

    expect(inFlight).toEqual({ outcome: 'fingerprint-mismatch' })
  })

  it('takes over a claim older than the timeout, so a crash cannot stick a key', async () => {
    await claim('k', 'fp-1', 'token-1')

    const later = NOW + (DEFAULT_CLAIM_TIMEOUT_SECONDS + 1) * 1000
    const decision = await claim('k', 'fp-1', 'token-2', later)

    expect(decision).toEqual({ outcome: 'proceed', claimToken: 'token-2' })
    expect(await store.getItem('k')).toMatchObject({ claimToken: 'token-2', createdAt: later })
  })

  it('holds a claim right up to the timeout and takes it over on the boundary', async () => {
    await claim('k', 'fp-1', 'token-1')

    const boundary = NOW + DEFAULT_CLAIM_TIMEOUT_SECONDS * 1000

    expect(await claim('k', 'fp-1', 'token-2', boundary - 1)).toEqual({ outcome: 'in-flight' })
    expect((await claim('k', 'fp-1', 'token-2', boundary)).outcome).toBe('proceed')
  })

  it('loses the read-back to a claim that landed after its own write', async () => {
    // The interleaving this models is write(A), write(B), read(A), read(B): A
    // reads B's token and must not proceed. It is the only concurrency this
    // scheme actually closes — see the note in the module about the window it
    // does not — so it is worth pinning rather than assuming.
    const key = 'k'
    const original = store.setItem.bind(store)
    let intercepted = false

    store.setItem = (async (...args: Parameters<typeof original>) => {
      await original(...args)
      if (!intercepted) {
        intercepted = true
        // B writes in the gap between A's write and A's read-back.
        await original(key, {
          state: 'in-flight',
          claimToken: 'token-B',
          fingerprint: 'fp-1',
          createdAt: NOW,
        })
      }
    }) as typeof store.setItem

    expect(await claim(key, 'fp-1', 'token-A')).toEqual({ outcome: 'in-flight' })
    expect(await store.getItem(key)).toMatchObject({ claimToken: 'token-B' })
  })

  it('keys are independent, so one caller cannot block another', async () => {
    await claim(idempotencyStoreKey('user-1', 'key-abcd'), 'fp-1', 'token-1')

    const other = await claim(idempotencyStoreKey('user-2', 'key-abcd'), 'fp-1', 'token-2')

    expect(other.outcome).toBe('proceed')
  })
})

describe('completeIdempotency', () => {
  it('stores the response and marks the record completed', async () => {
    await claim('k', 'fp-1', 'token-1')

    const written = await completeIdempotency(store, {
      key: 'k',
      claimToken: 'token-1',
      fingerprint: 'fp-1',
      response: RESPONSE,
      settings: SETTINGS,
      now: NOW + 5,
    })

    expect(written).toBe(true)
    expect(await store.getItem('k')).toEqual({
      state: 'completed',
      claimToken: 'token-1',
      fingerprint: 'fp-1',
      createdAt: NOW,
      completedAt: NOW + 5,
      response: RESPONSE,
    })
  })

  it('refuses to overwrite a claim another attempt has taken over', async () => {
    await claim('k', 'fp-1', 'token-1')
    const later = NOW + (DEFAULT_CLAIM_TIMEOUT_SECONDS + 1) * 1000
    await claim('k', 'fp-1', 'token-2', later)

    // The timed-out attempt finally finishes. Storing its answer now would hand
    // every later retry the older of two responses, and the live attempt's
    // completion would be the one discarded.
    const written = await completeIdempotency(store, {
      key: 'k',
      claimToken: 'token-1',
      fingerprint: 'fp-1',
      response: RESPONSE,
      settings: SETTINGS,
      now: later + 1,
    })

    expect(written).toBe(false)
    expect(await store.getItem('k')).toMatchObject({ state: 'in-flight', claimToken: 'token-2' })
  })

  it('writes a record whose claim expired underneath it', async () => {
    // The response is real and worth storing; there is simply no claim left.
    const written = await completeIdempotency(store, {
      key: 'k',
      claimToken: 'token-1',
      fingerprint: 'fp-1',
      response: RESPONSE,
      settings: SETTINGS,
      now: NOW,
    })

    expect(written).toBe(true)
    expect(await store.getItem('k')).toMatchObject({ state: 'completed', createdAt: NOW })
  })
})

describe('releaseIdempotencyClaim', () => {
  it('removes this request’s own claim, so the next attempt runs at once', async () => {
    await claim('k', 'fp-1', 'token-1')

    expect(await releaseIdempotencyClaim(store, 'k', 'token-1')).toBe(true)
    expect(await store.getItem('k')).toBeNull()
    expect((await claim('k', 'fp-1', 'token-2')).outcome).toBe('proceed')
  })

  it('never deletes a completed record', async () => {
    await claim('k', 'fp-1', 'token-1')
    await completeIdempotency(store, {
      key: 'k',
      claimToken: 'token-1',
      fingerprint: 'fp-1',
      response: RESPONSE,
      settings: SETTINGS,
      now: NOW,
    })

    expect(await releaseIdempotencyClaim(store, 'k', 'token-1')).toBe(false)
    expect(await store.getItem('k')).toMatchObject({ state: 'completed' })
  })

  it('never deletes a claim another attempt has taken over', async () => {
    await claim('k', 'fp-1', 'token-1')
    const later = NOW + (DEFAULT_CLAIM_TIMEOUT_SECONDS + 1) * 1000
    await claim('k', 'fp-1', 'token-2', later)

    expect(await releaseIdempotencyClaim(store, 'k', 'token-1')).toBe(false)
    expect(await store.getItem('k')).toMatchObject({ claimToken: 'token-2' })
  })

  it('is a no-op on a key that is not there', async () => {
    expect(await releaseIdempotencyClaim(store, 'missing', 'token-1')).toBe(false)
  })
})

describe('the retry a key exists for', () => {
  it('deduplicates a repeated request end to end', async () => {
    // The whole feature in one test: a client POSTs, the response is lost, and
    // the client retries the identical request with the same key.
    const body = new TextEncoder().encode('{"title":"buy milk"}')
    const fingerprint = await fingerprintRequest({ method: 'POST', path: '/api/todos', body })
    const key = idempotencyStoreKey('user-1', 'e0e6ac2c-2f4f-4d2c-9b0e-3f2d1c4b5a60')

    const first = await claim(key, fingerprint, 'token-1')
    expect(first.outcome).toBe('proceed')

    await completeIdempotency(store, {
      key,
      claimToken: 'token-1',
      fingerprint,
      response: RESPONSE,
      settings: SETTINGS,
      now: NOW + 20,
    })

    const retry = await claim(key, fingerprint, 'token-2', NOW + 5000)

    expect(retry).toEqual({ outcome: 'replay', response: RESPONSE })
  })
})
