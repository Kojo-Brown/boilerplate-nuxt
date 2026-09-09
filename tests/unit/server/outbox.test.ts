import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  DEFAULT_BASE_BACKOFF_MS,
  DEFAULT_BATCH_SIZE,
  DEFAULT_CLAIM_LEASE_MS,
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_MAX_BACKOFF_MS,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_PUBLISH_TIMEOUT_MS,
  MAX_BATCH_SIZE,
  MAX_LAST_ERROR_LENGTH,
  MIN_POLL_INTERVAL_MS,
  assertWebhookUrl,
  backoffDelayMs,
  createOutboxRelay,
  describeOutboxError,
  outboxBootWarning,
  relayBatch,
  resolveOutboxRelayPlan,
  resolveOutboxSettings,
  toBoolean,
  toClampedInt,
  type OutboxLogLevel,
  type OutboxRecord,
  type OutboxSettings,
  type OutboxStore,
} from '~/server/utils/outbox'

/**
 * A real queue on an in-memory table, not a mock store.
 *
 * Everything interesting about the relay is what a *second* pass sees after a
 * first one wrote: a claimed row that must not be claimed again until its lease
 * expires, a rescheduled row that must come back when its delay is up, a
 * dead-lettered row that must never come back at all. A mock returning whatever
 * each test expected would let all of that pass without the relay doing any of
 * it, so this implements the claim semantics `server/utils/outbox-store.ts`
 * implements in SQL — due-only, lease, limit, and `available_at, created_at`
 * order — against an array.
 *
 * What it deliberately does not model is concurrency. `SKIP LOCKED` is the part
 * that cannot be imitated in one process; it is asserted where it lives, on the
 * generated SQL, in `outbox-store.test.ts`.
 */
/**
 * A stored row: an {@link OutboxRecord} with its `readonly` stripped — the store
 * mutates these where the relay only reads them — plus the bookkeeping columns a
 * publisher never sees.
 */
type MemoryRow = { -readonly [K in keyof OutboxRecord]: OutboxRecord[K] } & {
  availableAt: Date
  publishedAt: Date | null
  failedAt: Date | null
  lastError: string | null
}

interface MemoryStore {
  readonly store: OutboxStore
  readonly rows: MemoryRow[]
  readonly seed: (records: readonly Partial<MemoryRow>[]) => void
  claims: number
  /** Set to make every store call reject, as an outage would. */
  failing: Error | null
}

const EPOCH = new Date('2026-01-01T00:00:00.000Z')

function createMemoryStore(): MemoryStore {
  const state: MemoryStore = {
    rows: [],
    claims: 0,
    failing: null,
    seed(records) {
      for (const [offset, record] of records.entries()) {
        state.rows.push({
          id: record.id ?? `row-${state.rows.length + 1}`,
          aggregateType: record.aggregateType ?? 'todo',
          aggregateId: record.aggregateId ?? 'todo-1',
          eventType: record.eventType ?? 'todo.created',
          payload: record.payload ?? { id: 'todo-1' },
          attempts: record.attempts ?? 0,
          createdAt: record.createdAt ?? new Date(EPOCH.getTime() + offset),
          availableAt: record.availableAt ?? EPOCH,
          publishedAt: record.publishedAt ?? null,
          failedAt: record.failedAt ?? null,
          lastError: record.lastError ?? null,
        })
      }
    },
    store: {
      claim({ limit, now, leaseMs }) {
        if (state.failing) return Promise.reject(state.failing)
        state.claims += 1
        const due = state.rows
          .filter(
            (row) =>
              row.publishedAt === null &&
              row.failedAt === null &&
              row.availableAt.getTime() <= now.getTime(),
          )
          .sort(
            (a, b) =>
              a.availableAt.getTime() - b.availableAt.getTime() ||
              a.createdAt.getTime() - b.createdAt.getTime(),
          )
          .slice(0, limit)

        return Promise.resolve(
          due.map((row) => {
            row.attempts += 1
            row.availableAt = new Date(now.getTime() + leaseMs)
            return {
              id: row.id,
              aggregateType: row.aggregateType,
              aggregateId: row.aggregateId,
              eventType: row.eventType,
              payload: row.payload,
              attempts: row.attempts,
              createdAt: row.createdAt,
            }
          }),
        )
      },
      markPublished({ id, now }) {
        if (state.failing) return Promise.reject(state.failing)
        const row = find(state.rows, id)
        row.publishedAt = now
        row.lastError = null
        return Promise.resolve()
      },
      reschedule({ id, availableAt, lastError }) {
        if (state.failing) return Promise.reject(state.failing)
        const row = find(state.rows, id)
        row.availableAt = availableAt
        row.lastError = lastError
        return Promise.resolve()
      },
      deadLetter({ id, now, lastError }) {
        if (state.failing) return Promise.reject(state.failing)
        const row = find(state.rows, id)
        row.failedAt = now
        row.lastError = lastError
        return Promise.resolve()
      },
    },
  }

  return state
}

function find(rows: MemoryRow[], id: string): MemoryRow {
  const row = rows.find((candidate) => candidate.id === id)
  if (!row) throw new Error(`Test bug: no outbox row ${id}`)
  return row
}

const SETTINGS: OutboxSettings = resolveOutboxSettings({})

describe('toClampedInt', () => {
  it('takes a number as it is when it is inside the bounds', () => {
    expect(toClampedInt(500, { fallback: 1, min: 0, max: 1000 })).toBe(500)
  })

  it('parses the strings a NUXT_ environment override arrives as', () => {
    expect(toClampedInt('750', { fallback: 1, min: 0, max: 1000 })).toBe(750)
    expect(toClampedInt(' 750 ', { fallback: 1, min: 0, max: 1000 })).toBe(750)
  })

  it('clamps rather than rejecting a value that is merely out of range', () => {
    expect(toClampedInt(9999, { fallback: 1, min: 0, max: 1000 })).toBe(1000)
    expect(toClampedInt(-5, { fallback: 1, min: 0, max: 1000 })).toBe(0)
  })

  it('falls back rather than clamping when the value is not a number at all', () => {
    // Clamping NaN would produce NaN, which is the silent failure this guards.
    for (const value of ['abc', undefined, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(toClampedInt(value, { fallback: 42, min: 0, max: 1000 })).toBe(42)
    }
  })

  it('treats a variable set to nothing as unset', () => {
    // `Number("")` is 0, not NaN, so without its own case `FOO=` would clamp to
    // the floor — for the poll interval, twenty polls a second.
    expect(toClampedInt('', { fallback: 42, min: 0, max: 1000 })).toBe(42)
    expect(toClampedInt('   ', { fallback: 42, min: 0, max: 1000 })).toBe(42)
  })

  it('floors a fraction instead of handing one to setTimeout', () => {
    expect(toClampedInt(10.9, { fallback: 1, min: 0, max: 1000 })).toBe(10)
  })
})

describe('toBoolean', () => {
  it('recognises the spellings an operator types', () => {
    expect(toBoolean('true', false)).toBe(true)
    expect(toBoolean('TRUE', false)).toBe(true)
    expect(toBoolean('1', false)).toBe(true)
    expect(toBoolean('false', true)).toBe(false)
    expect(toBoolean('0', true)).toBe(false)
    expect(toBoolean(false, true)).toBe(false)
  })

  it('falls back on anything else rather than being truthy', () => {
    // `Boolean('no')` is `true`, which is the bug this exists to avoid.
    expect(toBoolean('no', true)).toBe(true)
    expect(toBoolean('no', false)).toBe(false)
    expect(toBoolean(undefined, true)).toBe(true)
  })
})

describe('resolveOutboxSettings', () => {
  it('defaults everything when nothing is configured', () => {
    expect(resolveOutboxSettings({})).toEqual({
      pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
      batchSize: DEFAULT_BATCH_SIZE,
      baseBackoffMs: DEFAULT_BASE_BACKOFF_MS,
      maxBackoffMs: DEFAULT_MAX_BACKOFF_MS,
      maxAttempts: DEFAULT_MAX_ATTEMPTS,
      claimLeaseMs: DEFAULT_CLAIM_LEASE_MS,
      publishTimeoutMs: DEFAULT_PUBLISH_TIMEOUT_MS,
    })
  })

  it('clamps every value that came from the environment as a string', () => {
    const settings = resolveOutboxSettings({
      outbox: {
        relay: {
          pollIntervalMs: '1',
          batchSize: '100000',
          maxAttempts: '3',
          publishTimeoutMs: '250',
        },
      },
    })

    expect(settings.pollIntervalMs).toBe(MIN_POLL_INTERVAL_MS)
    expect(settings.batchSize).toBe(MAX_BATCH_SIZE)
    expect(settings.maxAttempts).toBe(3)
    expect(settings.publishTimeoutMs).toBe(250)
  })

  it('floors the backoff ceiling at the base delay', () => {
    // A ceiling below the first delay would make every retry wait the ceiling —
    // a fixed interval wearing the name of an exponential backoff.
    const settings = resolveOutboxSettings({
      outbox: { relay: { baseBackoffMs: 30_000, maxBackoffMs: 1_000 } },
    })

    expect(settings.baseBackoffMs).toBe(30_000)
    expect(settings.maxBackoffMs).toBe(30_000)
  })
})

describe('backoffDelayMs', () => {
  const settings = resolveOutboxSettings({
    outbox: { relay: { baseBackoffMs: 1_000, maxBackoffMs: 16_000 } },
  })

  it('doubles per attempt', () => {
    // Jitter pinned to the top of the window, so the exponential is visible.
    const top = () => 1
    expect(backoffDelayMs(1, settings, top)).toBe(1_000)
    expect(backoffDelayMs(2, settings, top)).toBe(2_000)
    expect(backoffDelayMs(3, settings, top)).toBe(4_000)
    expect(backoffDelayMs(4, settings, top)).toBe(8_000)
  })

  it('caps at maxBackoffMs however many attempts have been made', () => {
    const top = () => 1
    expect(backoffDelayMs(10, settings, top)).toBe(16_000)
    // 2 ** 2000 is Infinity; the delay is still the cap and not NaN.
    expect(backoffDelayMs(2_000, settings, top)).toBe(16_000)
  })

  it('never draws a delay below half the window', () => {
    // Full jitter's near-zero draws are indistinguishable from no backoff, which
    // against a consumer that is already down is a hot loop.
    for (const draw of [0, 0.25, 0.5, 0.999]) {
      const delay = backoffDelayMs(3, settings, () => draw)
      expect(delay).toBeGreaterThanOrEqual(2_000)
      expect(delay).toBeLessThanOrEqual(4_000)
    }
  })

  it('spreads a fleet of relays across the window', () => {
    const draws = [0, 0.2, 0.4, 0.6, 0.8].map((draw) => backoffDelayMs(2, settings, () => draw))
    expect(new Set(draws).size).toBe(draws.length)
  })
})

describe('describeOutboxError', () => {
  it('names the error and its message', () => {
    expect(describeOutboxError(new TypeError('fetch failed'))).toBe('TypeError: fetch failed')
  })

  it('flattens a multi-line message so a row holds one line', () => {
    expect(describeOutboxError(new Error('first\n  second'))).toBe('Error: first second')
  })

  it('truncates a consumer that answered with a stack trace', () => {
    const described = describeOutboxError(new Error('x'.repeat(5_000)))
    expect(described).toHaveLength(MAX_LAST_ERROR_LENGTH)
    expect(described.endsWith('…')).toBe(true)
  })

  it('handles the values that are not errors at all', () => {
    expect(describeOutboxError('plain string')).toBe('plain string')
    expect(describeOutboxError({ code: 503 })).toBe('{"code":503}')
    expect(describeOutboxError(undefined)).toBe('undefined')
  })

  it('survives a value JSON cannot serialise', () => {
    const circular: Record<string, unknown> = {}
    circular['self'] = circular
    expect(describeOutboxError(circular)).toBe('[object Object]')
  })
})

describe('relayBatch', () => {
  let memory: MemoryStore

  beforeEach(() => {
    memory = createMemoryStore()
  })

  it('publishes a due row and records the delivery', async () => {
    memory.seed([{ id: 'a' }])
    const delivered: OutboxRecord[] = []

    const outcome = await relayBatch({
      store: memory.store,
      publish: (record) => {
        delivered.push(record)
        return Promise.resolve()
      },
      settings: SETTINGS,
      now: () => EPOCH,
    })

    expect(outcome).toEqual({ claimed: 1, published: 1, retried: 0, deadLettered: 0 })
    expect(delivered.map((record) => record.id)).toEqual(['a'])
    // Attempt count is 1 on the first delivery: the claim increments it before
    // the publish is tried, so a publisher sees which attempt it is on.
    expect(delivered[0]?.attempts).toBe(1)
    expect(find(memory.rows, 'a').publishedAt).toEqual(EPOCH)
  })

  it('leaves a row that is not due yet alone', async () => {
    memory.seed([{ id: 'later', availableAt: new Date(EPOCH.getTime() + 60_000) }])

    const outcome = await relayBatch({
      store: memory.store,
      publish: () => Promise.reject(new Error('should not be called')),
      settings: SETTINGS,
      now: () => EPOCH,
    })

    expect(outcome.claimed).toBe(0)
  })

  it('reschedules a failed row with backoff instead of losing it', async () => {
    memory.seed([{ id: 'a' }])

    const outcome = await relayBatch({
      store: memory.store,
      publish: () => Promise.reject(new Error('consumer down')),
      settings: SETTINGS,
      now: () => EPOCH,
      random: () => 1,
    })

    expect(outcome).toEqual({ claimed: 1, published: 0, retried: 1, deadLettered: 0 })
    const row = find(memory.rows, 'a')
    expect(row.publishedAt).toBeNull()
    expect(row.failedAt).toBeNull()
    expect(row.lastError).toBe('Error: consumer down')
    // First retry at the base delay, jitter pinned to the top of the window.
    expect(row.availableAt).toEqual(new Date(EPOCH.getTime() + SETTINGS.baseBackoffMs))
  })

  it('dead-letters a row that has used its last attempt', async () => {
    const settings = resolveOutboxSettings({ outbox: { relay: { maxAttempts: 3 } } })
    // Two attempts already spent; the claim makes this the third.
    memory.seed([{ id: 'a', attempts: 2 }])
    const lines: [OutboxLogLevel, string][] = []

    const outcome = await relayBatch({
      store: memory.store,
      publish: () => Promise.reject(new Error('still down')),
      settings,
      now: () => EPOCH,
      log: (level, message) => lines.push([level, message]),
    })

    expect(outcome).toEqual({ claimed: 1, published: 0, retried: 0, deadLettered: 1 })
    const row = find(memory.rows, 'a')
    expect(row.failedAt).toEqual(EPOCH)
    expect(row.lastError).toBe('Error: still down')
    expect(lines[0]?.[0]).toBe('error')
    expect(lines[0]?.[1]).toContain('dead-lettered')
  })

  it('never claims a dead-lettered row again', async () => {
    memory.seed([{ id: 'a', failedAt: EPOCH, attempts: 10 }])

    const outcome = await relayBatch({
      store: memory.store,
      publish: () => Promise.reject(new Error('should not be called')),
      settings: SETTINGS,
      now: () => new Date(EPOCH.getTime() + 86_400_000),
    })

    expect(outcome.claimed).toBe(0)
  })

  it('publishes in available_at then created_at order', async () => {
    memory.seed([
      { id: 'third', createdAt: new Date(EPOCH.getTime() + 2) },
      { id: 'first', createdAt: new Date(EPOCH.getTime() + 0) },
      { id: 'second', createdAt: new Date(EPOCH.getTime() + 1) },
    ])
    const delivered: string[] = []

    await relayBatch({
      store: memory.store,
      publish: (record) => {
        delivered.push(record.id)
        return Promise.resolve()
      },
      settings: SETTINGS,
      now: () => EPOCH,
    })

    expect(delivered).toEqual(['first', 'second', 'third'])
  })

  it('keeps going after one row fails, rather than stalling the queue', async () => {
    memory.seed([{ id: 'bad' }, { id: 'good', createdAt: new Date(EPOCH.getTime() + 1) }])

    const outcome = await relayBatch({
      store: memory.store,
      publish: (record) =>
        record.id === 'bad' ? Promise.reject(new Error('nope')) : Promise.resolve(),
      settings: SETTINGS,
      now: () => EPOCH,
    })

    expect(outcome).toEqual({ claimed: 2, published: 1, retried: 1, deadLettered: 0 })
    expect(find(memory.rows, 'good').publishedAt).toEqual(EPOCH)
  })

  it('takes at most a batch, and the rest on the next pass', async () => {
    const settings = resolveOutboxSettings({ outbox: { relay: { batchSize: 2 } } })
    memory.seed([
      { id: 'a', createdAt: new Date(EPOCH.getTime() + 0) },
      { id: 'b', createdAt: new Date(EPOCH.getTime() + 1) },
      { id: 'c', createdAt: new Date(EPOCH.getTime() + 2) },
    ])
    const deps = {
      store: memory.store,
      publish: () => Promise.resolve(),
      settings,
      now: () => EPOCH,
    }

    expect((await relayBatch(deps)).claimed).toBe(2)
    expect((await relayBatch(deps)).claimed).toBe(1)
    expect((await relayBatch(deps)).claimed).toBe(0)
  })

  it('does not re-claim a row whose lease is still running', async () => {
    memory.seed([{ id: 'a' }])
    // A publisher that never settles is a relay killed mid-delivery: the row was
    // claimed and neither published nor rescheduled.
    void relayBatch({
      store: memory.store,
      publish: () => new Promise<void>(() => {}),
      settings: SETTINGS,
      now: () => EPOCH,
    })
    await Promise.resolve()

    const midLease = await relayBatch({
      store: memory.store,
      publish: () => Promise.resolve(),
      settings: SETTINGS,
      now: () => new Date(EPOCH.getTime() + SETTINGS.claimLeaseMs - 1),
    })
    expect(midLease.claimed).toBe(0)

    const afterLease = await relayBatch({
      store: memory.store,
      publish: () => Promise.resolve(),
      settings: SETTINGS,
      now: () => new Date(EPOCH.getTime() + SETTINGS.claimLeaseMs),
    })
    expect(afterLease.claimed).toBe(1)
    // The abandoned attempt was still counted — see "attempts count claims".
    expect(find(memory.rows, 'a').attempts).toBe(2)
  })

  it('propagates a store outage instead of recording it as a delivery failure', async () => {
    memory.seed([{ id: 'a' }])
    memory.failing = new Error('connection terminated')

    await expect(
      relayBatch({
        store: memory.store,
        publish: () => Promise.resolve(),
        settings: SETTINGS,
        now: () => EPOCH,
      }),
    ).rejects.toThrow('Outbox store write failed')
  })

  it('does not mistake a failing markPublished for a failing publisher', async () => {
    memory.seed([{ id: 'a' }])
    let published = 0

    await expect(
      relayBatch({
        store: {
          ...memory.store,
          markPublished: () => Promise.reject(new Error('write failed')),
        },
        publish: () => {
          published += 1
          return Promise.resolve()
        },
        settings: SETTINGS,
        now: () => EPOCH,
      }),
    ).rejects.toThrow('Outbox store write failed')

    // The event was delivered; the row was not marked, so the lease expiry will
    // deliver it again. At-least-once, visibly, rather than a row recorded as
    // "publish failed" by the store that just failed to record anything.
    expect(published).toBe(1)
    expect(find(memory.rows, 'a').lastError).toBeNull()
  })
})

describe('createOutboxRelay', () => {
  let memory: MemoryStore

  beforeEach(() => {
    memory = createMemoryStore()
    vi.useFakeTimers({ now: EPOCH })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('drains a backlog larger than one batch without waiting a poll interval', async () => {
    const settings = resolveOutboxSettings({ outbox: { relay: { batchSize: 2 } } })
    memory.seed([{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }, { id: 'e' }])

    const relay = createOutboxRelay({
      store: memory.store,
      publish: () => Promise.resolve(),
      settings,
    })

    relay.start()
    // No timer advanced at all: a pass that fills its batch polls again straight
    // away, so five rows drain in three passes without a single sleep.
    await vi.advanceTimersByTimeAsync(0)
    await relay.stop()

    expect(memory.rows.every((row) => row.publishedAt !== null)).toBe(true)
  })

  it('waits a poll interval after an under-full pass', async () => {
    const relay = createOutboxRelay({
      store: memory.store,
      publish: () => Promise.resolve(),
      settings: SETTINGS,
    })

    relay.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(memory.claims).toBe(1)

    await vi.advanceTimersByTimeAsync(SETTINGS.pollIntervalMs)
    expect(memory.claims).toBe(2)

    await relay.stop()
  })

  it('stops without waiting out the poll interval it is sleeping through', async () => {
    const relay = createOutboxRelay({
      store: memory.store,
      publish: () => Promise.resolve(),
      settings: resolveOutboxSettings({ outbox: { relay: { pollIntervalMs: 60_000 } } }),
    })

    relay.start()
    await vi.advanceTimersByTimeAsync(0)

    // No timer is advanced here. If the sleep were not cancellable this would
    // hang until the test timed out.
    await relay.stop()
    expect(memory.claims).toBe(1)
  })

  it('never runs two passes at once', async () => {
    memory.seed([{ id: 'a' }])
    let release = () => {}
    const inFlight = new Promise<void>((resolve) => {
      release = resolve
    })

    const relay = createOutboxRelay({
      store: memory.store,
      publish: () => inFlight,
      settings: SETTINGS,
    })

    relay.start()
    // Well past several poll intervals, with the first delivery still hanging.
    await vi.advanceTimersByTimeAsync(SETTINGS.pollIntervalMs * 5)
    expect(memory.claims).toBe(1)

    release()
    await relay.stop()
  })

  it('logs a store outage and keeps polling rather than dying', async () => {
    memory.failing = new Error('connection terminated')
    const lines: [OutboxLogLevel, string][] = []

    const relay = createOutboxRelay({
      store: memory.store,
      publish: () => Promise.resolve(),
      settings: SETTINGS,
      log: (level, message) => lines.push([level, message]),
    })

    relay.start()
    await vi.advanceTimersByTimeAsync(SETTINGS.pollIntervalMs)
    await relay.stop()

    expect(lines.length).toBeGreaterThanOrEqual(2)
    expect(lines[0]?.[0]).toBe('error')
    expect(lines[0]?.[1]).toContain('relay pass failed')
  })

  it('is idempotent in both directions', async () => {
    const relay = createOutboxRelay({
      store: memory.store,
      publish: () => Promise.resolve(),
      settings: SETTINGS,
    })

    relay.start()
    relay.start()
    await vi.advanceTimersByTimeAsync(0)
    // A second `start` must not leave a second loop polling the same table.
    expect(memory.claims).toBe(1)

    await relay.stop()
    await relay.stop()
  })

  it('runs a single pass on demand without being started', async () => {
    memory.seed([{ id: 'a' }])

    const relay = createOutboxRelay({
      store: memory.store,
      publish: () => Promise.resolve(),
      settings: SETTINGS,
    })

    expect((await relay.runOnce()).published).toBe(1)
    expect(memory.claims).toBe(1)
  })
})

describe('assertWebhookUrl', () => {
  it('accepts an HTTP or HTTPS endpoint', () => {
    expect(() => assertWebhookUrl('https://example.test/hooks/outbox')).not.toThrow()
    expect(() => assertWebhookUrl('http://localhost:4000/events')).not.toThrow()
  })

  it('rejects a value that is not a URL', () => {
    expect(() => assertWebhookUrl('example.test/hooks')).toThrow('NUXT_OUTBOX_WEBHOOK_URL')
  })

  it('rejects a scheme that is not HTTP', () => {
    expect(() => assertWebhookUrl('redis://localhost:6379')).toThrow('not HTTP')
  })

  it('names the variable without echoing the URL, which carries tokens', () => {
    expect(() => assertWebhookUrl('ftp://host/secret-token-in-path')).toThrow(
      /^NUXT_OUTBOX_WEBHOOK_URL has protocol "ftp:"/,
    )
  })
})

describe('resolveOutboxRelayPlan', () => {
  const withDatabase = { databaseUrl: 'postgresql://localhost:5432/app' }

  it('delivers over HTTP when a webhook is configured', () => {
    const plan = resolveOutboxRelayPlan(
      { ...withDatabase, outbox: { webhookUrl: 'https://example.test/hooks' } },
      false,
    )

    expect(plan.mode).toBe('http')
    expect(plan).toMatchObject({ url: 'https://example.test/hooks' })
  })

  it('logs instead of delivering in development, so the path is observable', () => {
    expect(resolveOutboxRelayPlan(withDatabase, true).mode).toBe('log')
  })

  it('refuses to log-and-mark-delivered in a built server', () => {
    expect(resolveOutboxRelayPlan(withDatabase, false)).toMatchObject({
      mode: 'disabled',
      reason: 'no-destination',
    })
  })

  it('does not poll a database that is not configured', () => {
    expect(resolveOutboxRelayPlan({ databaseUrl: '  ' }, true)).toMatchObject({
      mode: 'disabled',
      reason: 'no-database',
    })
  })

  it('honours the off switch before anything else', () => {
    const plan = resolveOutboxRelayPlan(
      { ...withDatabase, outbox: { webhookUrl: 'not-a-url', relay: { enabled: 'false' } } },
      false,
    )

    // Turned off wins over the unusable URL: an instance that was told not to
    // deliver must not fail to boot over a destination it will never use.
    expect(plan).toMatchObject({ mode: 'disabled', reason: 'turned-off' })
  })

  it('fails the boot on a webhook that is set and unusable', () => {
    expect(() =>
      resolveOutboxRelayPlan({ ...withDatabase, outbox: { webhookUrl: 'not-a-url' } }, false),
    ).toThrow('NUXT_OUTBOX_WEBHOOK_URL')
  })

  it('carries the resolved settings whatever the mode', () => {
    const config = { ...withDatabase, outbox: { relay: { batchSize: '5' } } }
    expect(resolveOutboxRelayPlan(config, true).settings.batchSize).toBe(5)
    expect(resolveOutboxRelayPlan(config, false).settings.batchSize).toBe(5)
  })
})

describe('outboxBootWarning', () => {
  const settings = resolveOutboxSettings({})

  it('warns a built server that will enqueue and never deliver', () => {
    const warning = outboxBootWarning(
      { mode: 'disabled', reason: 'no-destination', settings },
      false,
    )

    expect(warning).toContain('NUXT_OUTBOX_WEBHOOK_URL')
    expect(warning).toContain('nothing is lost')
  })

  it('says nothing about a state the operator chose', () => {
    expect(outboxBootWarning({ mode: 'http', url: 'https://x.test', settings }, false)).toBeNull()
    expect(
      outboxBootWarning({ mode: 'disabled', reason: 'turned-off', settings }, false),
    ).toBeNull()
    expect(
      outboxBootWarning({ mode: 'disabled', reason: 'no-database', settings }, false),
    ).toBeNull()
  })

  it('says nothing in development, where logging is the intended setup', () => {
    expect(
      outboxBootWarning({ mode: 'disabled', reason: 'no-destination', settings }, true),
    ).toBeNull()
  })
})
