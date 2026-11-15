import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { todos, type Todo } from '~/server/db/schema'
import { readConflict, todoDeleteStatement, todoUpdateStatement } from '~/server/utils/todo-store'

import { connect, hold, truncateAll, waitUntilBlocked, type TestConnection } from './setup/database'

/**
 * Optimistic concurrency, against a database that can actually be raced.
 *
 * `tests/unit/server/todo-store.test.ts` reads the SQL these functions emit and
 * proves the `AND version = $expected` predicate is in the statement. That is
 * the necessary half. This is the half it says it cannot do: whether Postgres,
 * given two sessions that both read version 1, lets exactly one of them write
 * version 2 — which is a question about row locks and about what a blocked
 * `UPDATE` does when the transaction ahead of it commits, and has no answer
 * that does not involve a real server.
 *
 * Both sessions here are real connections (`max: 1`, so a client is a session),
 * and the interleaving is forced rather than hoped for: the first write is held
 * in an open transaction, the second is issued, and the test waits until
 * Postgres reports that second backend parked on a lock before letting the
 * first commit. No sleeps.
 */
let alice: TestConnection
let bob: TestConnection
/**
 * A third session, for looking at rows — and at `pg_stat_activity` — while one
 * of the other two is holding a transaction open. Every client is `max: 1`,
 * which is what makes a client a session: a read issued on the holding
 * connection would queue behind the transaction it is trying to observe, and
 * asking the *blocked* session whether it is blocked cannot work at all.
 */
let observer: TestConnection

beforeAll(async () => {
  ;[alice, bob, observer] = await Promise.all([connect(), connect(), connect()])
})

afterAll(async () => {
  await Promise.all([alice.close(), bob.close(), observer.close()])
})

beforeEach(async () => {
  await truncateAll(alice.sql)
})

const AT = new Date('2026-03-01T12:00:00.000Z')

async function seed(title = 'write the integration suite'): Promise<Todo> {
  const [row] = await alice.db.insert(todos).values({ title }).returning()
  if (row === undefined) throw new Error('insert returned no row')
  return row
}

function read(id: string): Promise<Todo[]> {
  return observer.db.select().from(todos).where(eq(todos.id, id))
}

describe('the version-guarded update', () => {
  it('bumps the version and returns the new row', async () => {
    const todo = await seed()

    const [updated] = await todoUpdateStatement(alice.db, {
      id: todo.id,
      expected: todo.version,
      values: { title: 'renamed', completed: true },
      now: AT,
    })

    expect(updated).toMatchObject({ title: 'renamed', completed: true, version: 2 })
    expect(updated?.updatedAt).toEqual(AT)
  })

  it('matches no row when the expected version has moved on', async () => {
    const todo = await seed()
    await todoUpdateStatement(alice.db, {
      id: todo.id,
      expected: 1,
      values: { title: 'first' },
      now: AT,
    })

    const missed = await todoUpdateStatement(alice.db, {
      id: todo.id,
      expected: 1,
      values: { title: 'second' },
      now: AT,
    })

    expect(missed).toEqual([])
    // And left the row exactly as the first write made it — a guarded update
    // that missed must not be a partial write.
    expect((await read(todo.id))[0]).toMatchObject({ title: 'first', version: 2 })
  })

  it('writes whatever version is there when the guard is dropped', async () => {
    // `expected: null` is `If-Match: *` — "the row must exist", nothing about
    // which version.
    const todo = await seed()
    await todoUpdateStatement(alice.db, {
      id: todo.id,
      expected: 1,
      values: { title: 'moved on' },
      now: AT,
    })

    const [updated] = await todoUpdateStatement(alice.db, {
      id: todo.id,
      expected: null,
      values: { completed: true },
      now: AT,
    })

    expect(updated).toMatchObject({ title: 'moved on', completed: true, version: 3 })
  })

  it('increments in SQL, so concurrent guarded writers cannot both reach the same version', async () => {
    const todo = await seed()

    // Alice writes and holds her transaction open: the row is locked and her
    // version 2 is not visible to anyone yet.
    const held = await hold(alice.db, (tx) =>
      todoUpdateStatement(tx, {
        id: todo.id,
        expected: 1,
        values: { title: 'alice' },
        now: AT,
      }),
    )
    expect(await held.value).toHaveLength(1)

    // Bob read version 1 before any of this — his request is already in flight
    // with `If-Match: "1"`. His UPDATE blocks on Alice's lock.
    // Sent through an async wrapper rather than awaited: a Drizzle builder is
    // a thenable and postgres-js only puts the query on the wire when somebody
    // subscribes to it, so `const p = builder` would leave Bob idle and
    // `waitUntilBlocked` waiting for a lock nobody is asking for.
    const bobsWrite = (async () =>
      await todoUpdateStatement(bob.db, {
        id: todo.id,
        expected: 1,
        values: { title: 'bob' },
        now: AT,
      }))()

    await waitUntilBlocked(observer.sql, bob.pid)
    await held.commit()

    // Released, Postgres re-checks the predicate against the row Alice
    // committed — version 2 now, so Bob's `version = 1` matches nothing. This
    // is the whole guarantee, and it is Postgres' behaviour, not ours: under
    // READ COMMITTED a blocked UPDATE re-evaluates its WHERE against the
    // updated row rather than against the snapshot it started with.
    await expect(bobsWrite).resolves.toEqual([])
    expect((await read(todo.id))[0]).toMatchObject({ title: 'alice', version: 2 })
  })

  it('is what stops the same interleaving losing a write', async () => {
    // The same race against the implementation the guard exists to rule out:
    // read the row, work out the next version in TypeScript, write it. It
    // passes every single-request test, and here it silently destroys Alice's
    // write — with the version landing on 2 either way, so the row afterwards
    // does not even show that two updates happened.
    const todo = await seed()

    const held = await hold(alice.db, (tx) =>
      todoUpdateStatement(tx, {
        id: todo.id,
        expected: 1,
        values: { title: 'alice' },
        now: AT,
      }),
    )
    expect(await held.value).toHaveLength(1)

    const [seen] = await bob.db.select().from(todos).where(eq(todos.id, todo.id))
    expect(seen?.version).toBe(1)

    const unguarded = (async () =>
      await bob.db
        .update(todos)
        .set({ title: 'bob', updatedAt: AT, version: (seen?.version ?? 0) + 1 })
        .where(eq(todos.id, todo.id))
        .returning())()

    await waitUntilBlocked(observer.sql, bob.pid)
    await held.commit()

    const [after] = await unguarded
    expect(after).toMatchObject({ title: 'bob', version: 2 })
  })
})

describe('the version-guarded delete', () => {
  it('returns what it removed', async () => {
    const todo = await seed()

    const removed = await todoDeleteStatement(alice.db, { id: todo.id, expected: 1 })

    expect(removed).toEqual([{ id: todo.id, version: 1 }])
    expect(await read(todo.id)).toEqual([])
  })

  it('keeps a row whose version has moved on', async () => {
    const todo = await seed()
    await todoUpdateStatement(alice.db, {
      id: todo.id,
      expected: 1,
      values: { completed: true },
      now: AT,
    })

    expect(await todoDeleteStatement(alice.db, { id: todo.id, expected: 1 })).toEqual([])
    expect(await read(todo.id)).toHaveLength(1)
  })

  it('cannot delete the same row twice under a race', async () => {
    const todo = await seed()

    const held = await hold(alice.db, (tx) => todoDeleteStatement(tx, { id: todo.id, expected: 1 }))
    expect(await held.value).toHaveLength(1)

    const bobsDelete = (async () =>
      await todoDeleteStatement(bob.db, { id: todo.id, expected: 1 }))()

    await waitUntilBlocked(observer.sql, bob.pid)
    await held.commit()

    // The row Bob's statement was waiting on is gone rather than changed, and a
    // DELETE whose target vanished matches nothing. Two concurrent deletes
    // therefore produce one 204 and one 412, never two 204s.
    await expect(bobsDelete).resolves.toEqual([])
  })
})

describe('readConflict', () => {
  it('reports the version a stale write lost to', async () => {
    const todo = await seed()
    await todoUpdateStatement(alice.db, {
      id: todo.id,
      expected: 1,
      values: { title: 'winner' },
      now: AT,
    })

    const conflict = await readConflict(alice.db, todo.id)

    expect(conflict.miss).toEqual({ kind: 'stale', actual: 2 })
    expect(conflict.current).toMatchObject({ title: 'winner', version: 2 })
  })

  it('reports a deleted row as missing rather than as stale', async () => {
    const todo = await seed()
    await todoDeleteStatement(alice.db, { id: todo.id, expected: null })

    expect(await readConflict(alice.db, todo.id)).toEqual({
      miss: { kind: 'missing' },
      current: null,
    })
  })

  it('sees a delete committed after the failed write, even from inside the transaction', async () => {
    // Pinned because it is the opposite of what the obvious reading of "run it
    // inside the same transaction" suggests. The transaction keeps the two
    // statements on one session, which is what the routes need; it does not
    // freeze what they see. Under READ COMMITTED — the default, and what these
    // routes run at — every statement takes a fresh snapshot, so a row deleted
    // and committed by somebody else between the missed update and the re-read
    // is reported as `missing`. The route then answers 412 with "it is gone"
    // rather than 412 with a version to merge against, which is the better of
    // the two answers; what would be wrong is believing the re-read cannot see
    // it, and writing the next piece of conflict handling on that belief.
    const todo = await seed()
    await todoUpdateStatement(alice.db, {
      id: todo.id,
      expected: 1,
      values: { title: 'moved on' },
      now: AT,
    })

    const held = await hold(alice.db, async (tx) => {
      const missed = await todoUpdateStatement(tx, {
        id: todo.id,
        expected: 1,
        values: { title: 'stale writer' },
        now: AT,
      })
      expect(missed).toEqual([])

      // Committed by another session while this transaction is still open.
      await bob.db.delete(todos).where(eq(todos.id, todo.id))

      return readConflict(tx, todo.id)
    })

    expect(await held.value).toEqual({ miss: { kind: 'missing' }, current: null })
    await held.commit()
  })
})
