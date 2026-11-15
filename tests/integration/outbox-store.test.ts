import { and, asc, eq, isNull, lte } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { outbox, todos, type OutboxRow } from '~/server/db/schema'
import { relayBatch, type OutboxMessage, type OutboxSettings } from '~/server/utils/outbox'
import {
  claimStatement,
  createDrizzleOutboxStore,
  deadLetterStatement,
  enqueueOutbox,
  markPublishedStatement,
  rescheduleStatement,
} from '~/server/utils/outbox-store'
import { todoCreatedMessage } from '~/server/utils/todo-events'

import { connect, hold, sqlState, truncateAll, type TestConnection } from './setup/database'

/**
 * The outbox against a real Postgres: the two claims the unit suite names as
 * out of its reach.
 *
 * The first is **atomicity**. `enqueueOutbox(tx, …)` is only worth anything if
 * the event and the change it describes commit or roll back together, and
 * `pg-proxy` — the driver `tests/unit/server/outbox-store.test.ts` runs on —
 * refuses `transaction()` outright, so nothing there has ever rolled anything
 * back.
 *
 * The second is **`FOR UPDATE SKIP LOCKED`**. The unit suite proves the words
 * are in the statement; it cannot show Postgres honouring them, and that is the
 * property whose absence is invisible until the day a second instance is
 * deployed and every event is published twice. Here the first relay's claim is
 * held in an open transaction while a second relay claims against it, so what
 * is measured is the lock, not the SQL string.
 */
let relayA: TestConnection
let relayB: TestConnection
/** A third session: reads and `pg_stat_activity` while the other two hold locks. */
let observer: TestConnection

beforeAll(async () => {
  ;[relayA, relayB, observer] = await Promise.all([connect(), connect(), connect()])
})

afterAll(async () => {
  await Promise.all([relayA.close(), relayB.close(), observer.close()])
})

beforeEach(async () => {
  await truncateAll(relayA.sql)
})

const AT = new Date('2026-03-01T12:00:00.000Z')
const LEASE_MS = 30_000

function message(index: number): OutboxMessage {
  return {
    aggregateType: 'todo',
    aggregateId: `todo-${index}`,
    eventType: 'todo.created',
    payload: { index },
  }
}

/** Seeds `count` due rows, oldest first, one second apart. */
async function seedDue(count: number): Promise<OutboxRow[]> {
  for (let index = 0; index < count; index += 1) {
    await relayA.db.insert(outbox).values({
      ...message(index),
      availableAt: new Date(AT.getTime() - (count - index) * 1_000),
      createdAt: new Date(AT.getTime() - (count - index) * 1_000),
    })
  }

  return observer.db.select().from(outbox).orderBy(asc(outbox.createdAt))
}

function rows(): Promise<OutboxRow[]> {
  return observer.db.select().from(outbox).orderBy(asc(outbox.createdAt))
}

describe('enqueueOutbox is atomic with the change it describes', () => {
  it('keeps the row and the event when the transaction commits', async () => {
    await relayA.db.transaction(async (tx) => {
      const [todo] = await tx.insert(todos).values({ title: 'buy milk' }).returning()
      if (todo === undefined) throw new Error('insert returned no row')
      await enqueueOutbox(tx, [todoCreatedMessage(todo)])
    })

    expect(await observer.db.select().from(todos)).toHaveLength(1)

    const [event] = await rows()
    expect(event).toMatchObject({
      aggregateType: 'todo',
      eventType: 'todo.created',
      attempts: 0,
      publishedAt: null,
      failedAt: null,
      lastError: null,
    })
  })

  it('keeps neither when the transaction rolls back', async () => {
    // The failure the outbox exists to prevent, from the inside: the handler
    // throws after both writes. If the event were written on the connection
    // rather than on the transaction, this is where it would survive — an event
    // announcing a todo nobody can read.
    await expect(
      relayA.db.transaction(async (tx) => {
        const [todo] = await tx.insert(todos).values({ title: 'buy milk' }).returning()
        if (todo === undefined) throw new Error('insert returned no row')
        await enqueueOutbox(tx, [todoCreatedMessage(todo)])
        throw new Error('handler failed after both writes')
      }),
    ).rejects.toThrow('handler failed after both writes')

    expect(await observer.db.select().from(todos)).toEqual([])
    expect(await rows()).toEqual([])
  })

  it('is invisible outside the transaction until it commits', async () => {
    const held = await hold(relayA.db, (tx) => enqueueOutbox(tx, [message(0)]))
    await held.value

    expect(await rows()).toEqual([])

    await held.commit()
    expect(await rows()).toHaveLength(1)
  })

  it('writes nothing for an empty batch', async () => {
    // Not a style point: `INSERT INTO outbox VALUES` with no rows is a syntax
    // error in Postgres, so a handler whose change produced no events would
    // fail at the database rather than commit quietly.
    await expect(enqueueOutbox(relayA.db, [])).resolves.toBeUndefined()
    expect(await rows()).toEqual([])
  })
})

describe('the claim, with a second relay competing for the same rows', () => {
  it('hands two relays disjoint rows rather than the same ones', async () => {
    await seedDue(4)

    // Relay A claims two and does not commit: in production this is the window
    // in which it is publishing them, which is a network call and the longest
    // part of the pass.
    const held = await hold(relayA.db, (tx) =>
      claimStatement(tx, { limit: 2, now: AT, leaseMs: LEASE_MS }),
    )
    const claimedByA = await held.value
    expect(claimedByA).toHaveLength(2)

    // Relay B claims while A still holds its rows. `SKIP LOCKED` is what makes
    // this return at all rather than blocking, and what makes it return
    // *different* rows.
    const claimedByB = await claimStatement(relayB.db, {
      limit: 2,
      now: AT,
      leaseMs: LEASE_MS,
    })

    await held.commit()

    const idsA = claimedByA.map((row) => row.id)
    const idsB = claimedByB.map((row) => row.id)
    expect(idsB).toHaveLength(2)
    expect(idsA.filter((id) => idsB.includes(id))).toEqual([])
    expect(new Set([...idsA, ...idsB]).size).toBe(4)
  })

  it('would block without SKIP LOCKED', async () => {
    // The control for the test above. Same rows, same held transaction, same
    // `FOR UPDATE` — only the `skipLocked` flag removed — and the second relay
    // waits instead of working. That is what `claimStatement` would do if the
    // option were ever dropped, and it is the difference between two relays
    // sharing a queue and two relays taking turns at it.
    await seedDue(2)

    const held = await hold(relayA.db, (tx) =>
      claimStatement(tx, { limit: 2, now: AT, leaseMs: LEASE_MS }),
    )
    expect(await held.value).toHaveLength(2)

    await relayB.sql`set statement_timeout = '750ms'`

    const withoutSkipLocked = (async () =>
      await relayB.db
        .select({ id: outbox.id })
        .from(outbox)
        .where(
          and(isNull(outbox.publishedAt), isNull(outbox.failedAt), lte(outbox.availableAt, AT)),
        )
        .orderBy(outbox.availableAt, outbox.createdAt)
        .limit(2)
        .for('update'))()

    // 57014 is `query_canceled` — the statement timeout firing, because the
    // row lock never came free. The second relay got no work done, which is
    // the point.
    const refused = await withoutSkipLocked.then(() => undefined).catch((error: unknown) => error)
    expect(sqlState(refused)).toBe('57014')

    await relayB.sql`set statement_timeout = default`
    await held.commit()
  })

  it('takes the oldest due rows, up to the limit', async () => {
    const seeded = await seedDue(3)

    const claimed = await claimStatement(relayA.db, { limit: 2, now: AT, leaseMs: LEASE_MS })

    // Which rows, not in which order: the subquery's `ORDER BY` decides the
    // selection, and the `UPDATE … RETURNING` wrapped around it has no defined
    // row order at all. It really does differ — this assertion was written as
    // an ordered one and the first run against Postgres returned the batch
    // backwards. Delivery order is restored by `createDrizzleOutboxStore`, and
    // asserted below where it belongs, on the port the relay actually uses.
    expect(new Set(claimed.map((row) => row.aggregateId))).toEqual(
      new Set([seeded[0]?.aggregateId, seeded[1]?.aggregateId]),
    )
  })

  it('hands the relay its batch in commit order', async () => {
    await seedDue(3)

    const claimed = await createDrizzleOutboxStore(relayA.db).claim({
      limit: 3,
      now: AT,
      leaseMs: LEASE_MS,
    })

    // `outbox.ts` promises that an idle queue delivers in commit order, and
    // `relayBatch` publishes the array it is given in order, so this is the
    // only place that promise can be kept.
    expect(claimed.map((record) => record.aggregateId)).toEqual(['todo-0', 'todo-1', 'todo-2'])
  })

  it('leases what it claims, so the next poll steps over it', async () => {
    await seedDue(1)

    const [claimed] = await claimStatement(relayA.db, { limit: 10, now: AT, leaseMs: LEASE_MS })
    expect(claimed?.attempts).toBe(1)
    expect(claimed?.availableAt).toEqual(new Date(AT.getTime() + LEASE_MS))

    // Same instant, a second poll: the row is not locked any more — the claim
    // committed — it is simply not due. That is what makes a relay that dies
    // mid-publish recoverable with no reaper: the lease expires on its own.
    expect(await claimStatement(relayA.db, { limit: 10, now: AT, leaseMs: LEASE_MS })).toEqual([])

    const afterExpiry = new Date(AT.getTime() + LEASE_MS + 1)
    const [reclaimed] = await claimStatement(relayB.db, {
      limit: 10,
      now: afterExpiry,
      leaseMs: LEASE_MS,
    })

    expect(reclaimed?.id).toBe(claimed?.id)
    expect(reclaimed?.attempts).toBe(2)
  })

  it('ignores rows that are published or dead-lettered', async () => {
    const seeded = await seedDue(3)
    const [first, second, third] = seeded
    if (first === undefined || second === undefined || third === undefined) {
      throw new Error('seed produced fewer rows than expected')
    }

    await markPublishedStatement(relayA.db, { id: first.id, now: AT })
    await deadLetterStatement(relayA.db, { id: second.id, now: AT, lastError: 'gave up' })

    const claimed = await claimStatement(relayA.db, { limit: 10, now: AT, leaseMs: LEASE_MS })

    expect(claimed.map((row) => row.id)).toEqual([third.id])
  })
})

describe('recording what happened to a claimed row', () => {
  it('marks a delivery and clears the error from the attempt before it', async () => {
    const [seeded] = await seedDue(1)
    if (seeded === undefined) throw new Error('seed produced no row')

    await rescheduleStatement(relayA.db, {
      id: seeded.id,
      availableAt: AT,
      lastError: 'consumer returned 503',
    })
    await markPublishedStatement(relayA.db, { id: seeded.id, now: AT })

    const [row] = await rows()
    expect(row).toMatchObject({ publishedAt: AT, lastError: null, failedAt: null })
  })

  it('will not let a second relay overwrite the first delivery', async () => {
    // The lease can expire while a relay is still publishing, so two relays can
    // legitimately hold the same row. The re-check of `published_at IS NULL` is
    // what keeps the timestamp honest: it is when the event was first
    // delivered, not when the last duplicate finished.
    const [seeded] = await seedDue(1)
    if (seeded === undefined) throw new Error('seed produced no row')

    await markPublishedStatement(relayA.db, { id: seeded.id, now: AT })
    const later = new Date(AT.getTime() + 60_000)
    await markPublishedStatement(relayB.db, { id: seeded.id, now: later })

    expect((await rows())[0]?.publishedAt).toEqual(AT)
  })

  it('puts a failed row back on the queue with its reason', async () => {
    const [seeded] = await seedDue(1)
    if (seeded === undefined) throw new Error('seed produced no row')

    const retryAt = new Date(AT.getTime() + 5_000)
    await rescheduleStatement(relayA.db, {
      id: seeded.id,
      availableAt: retryAt,
      lastError: 'consumer returned 503',
    })

    expect((await rows())[0]).toMatchObject({
      availableAt: retryAt,
      lastError: 'consumer returned 503',
      publishedAt: null,
      failedAt: null,
    })
    expect(await claimStatement(relayA.db, { limit: 10, now: AT, leaseMs: LEASE_MS })).toEqual([])
  })

  it('keeps a dead letter in the table and out of the queue', async () => {
    const [seeded] = await seedDue(1)
    if (seeded === undefined) throw new Error('seed produced no row')

    await deadLetterStatement(relayA.db, { id: seeded.id, now: AT, lastError: 'gave up' })

    const [row] = await rows()
    expect(row).toMatchObject({ failedAt: AT, lastError: 'gave up', publishedAt: null })
    // Still there to be read and replayed by hand — the payload is the only
    // record that the event was owed.
    expect(row?.payload).toEqual({ index: 0 })
    expect(
      await claimStatement(relayA.db, {
        limit: 10,
        now: new Date(AT.getTime() + 86_400_000),
        leaseMs: LEASE_MS,
      }),
    ).toEqual([])
  })
})

describe('relayBatch over the real store', () => {
  const settings: OutboxSettings = {
    pollIntervalMs: 1_000,
    batchSize: 10,
    baseBackoffMs: 1_000,
    maxBackoffMs: 60_000,
    maxAttempts: 3,
    claimLeaseMs: LEASE_MS,
    publishTimeoutMs: 5_000,
  }

  it('publishes what it can and reschedules what it cannot', async () => {
    await seedDue(2)

    const outcome = await relayBatch({
      store: createDrizzleOutboxStore(relayA.db),
      publish: (record) => {
        if (record.aggregateId === 'todo-1') throw new Error('consumer returned 503')
        return Promise.resolve()
      },
      settings,
      now: () => AT,
      random: () => 0.5,
    })

    expect(outcome).toEqual({ claimed: 2, published: 1, retried: 1, deadLettered: 0 })

    const [delivered, retried] = await rows()
    expect(delivered).toMatchObject({ publishedAt: AT, lastError: null })
    // `describeOutboxError` keeps the error's class in the text, because
    // "503" and "TypeError" are different kinds of bad day for whoever reads
    // the column.
    expect(retried).toMatchObject({ publishedAt: null, lastError: 'Error: consumer returned 503' })
    expect(retried?.availableAt.getTime()).toBeGreaterThan(AT.getTime())
  })

  it('dead-letters a row that has used its attempts', async () => {
    await relayA.db.insert(outbox).values({
      ...message(0),
      availableAt: new Date(AT.getTime() - 1_000),
      // Already claimed three times; `maxAttempts` is 3, and the claim in this
      // pass takes it to 4.
      attempts: 3,
    })

    const outcome = await relayBatch({
      store: createDrizzleOutboxStore(relayA.db),
      publish: () => Promise.reject(new Error('consumer is gone')),
      settings,
      now: () => AT,
    })

    expect(outcome).toEqual({ claimed: 1, published: 0, retried: 0, deadLettered: 1 })
    expect((await rows())[0]).toMatchObject({ failedAt: AT, lastError: 'Error: consumer is gone' })
  })

  it('leaves a row claimed by another relay alone', async () => {
    await seedDue(2)

    const held = await hold(relayA.db, (tx) =>
      claimStatement(tx, { limit: 1, now: AT, leaseMs: LEASE_MS }),
    )
    const [takenByA] = await held.value
    if (takenByA === undefined) throw new Error('relay A claimed nothing')

    const published: string[] = []
    const outcome = await relayBatch({
      store: createDrizzleOutboxStore(relayB.db),
      publish: (record) => {
        published.push(record.aggregateId)
        return Promise.resolve()
      },
      settings,
      now: () => AT,
    })

    await held.commit()

    expect(outcome.claimed).toBe(1)
    expect(published).not.toContain(takenByA.aggregateId)
    expect(
      (await observer.db.select().from(outbox).where(eq(outbox.id, takenByA.id)))[0]?.publishedAt,
    ).toBeNull()
  })
})
