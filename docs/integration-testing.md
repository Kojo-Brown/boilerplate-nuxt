# Integration testing: a real Postgres, started by the suite

Every other test of this project's data access runs against a database that
cannot say no. `tests/unit/server/todo-store.test.ts` and
`tests/unit/server/outbox-store.test.ts` drive a **real Drizzle instance**
through the `pg-proxy` driver, which takes a callback in place of a connection:
they read the SQL the query builder emits and assert on it exactly. That is a
good test and it is the right tool for "is `FOR UPDATE SKIP LOCKED` in the
statement" — but the callback answers whatever the test tells it to, so it
would answer just as cheerfully for a table no migration has ever created, and
it cannot show Postgres honouring a lock, rolling a transaction back, or
re-evaluating a predicate after the transaction ahead of it commits.

These suites are for the claims that need a server.

```
pnpm test:integration
  │
  ├─ vitest.integration.config.ts        ← one fork, suites in series
  │
  ├─ tests/integration/setup/global.ts   ← starts postgres:17-alpine (Testcontainers)
  │    └─ applies server/db/migrations/*.sql to an empty database, in order
  │
  ├─ tests/integration/migrations.test.ts    ← the migrations match schema.ts
  ├─ tests/integration/todo-store.test.ts    ← optimistic concurrency, raced
  └─ tests/integration/outbox-store.test.ts  ← atomicity and SKIP LOCKED
```

It needs a Docker socket and nothing else: no `DATABASE_URL`, no service to
start, no `docker compose up`. The container is thrown away at the end of the
run. The whole thing is about five seconds once the image is local.

## What each suite is for

### `migrations.test.ts`

Holds `server/db/migrations/` against `server/db/schema.ts` on a database built
from the migrations **and nothing else**. Every table in the schema has to
exist, with every column the schema declares, at the SQL type and nullability
it declares — compared through Drizzle's own `getTableConfig`, so the two
artefacts that can actually disagree are the two being compared.

This is the suite that paid for itself first. `uploads` was in `schema.ts`, was
inserted into by `POST /api/uploads` and `POST /api/uploads/direct`, was read by
`GET /api/uploads` — and no migration created it. All three routes answered 500
(`relation "uploads" does not exist`) against any database built from this
repository, for two releases, with a green suite the whole time.
`0003_uploads.sql` is the fix.

It also pins that the migrations are re-runnable (every statement is
`IF NOT EXISTS`, which is a claim worth checking, because a migration that is
not idempotent turns a retried deploy into an outage) and that
`outbox_pending_idx` keeps its `WHERE` — an index that has lost its predicate
grows with the delivered history instead of with the backlog, and nothing else
here would notice.

### `todo-store.test.ts`

Optimistic concurrency against a database that can be raced. Two real sessions
read version 1; exactly one of them writes version 2. The interleaving is
forced, not hoped for: the first write is held in an open transaction, the
second is issued, and the test waits until Postgres reports that backend parked
on a lock (`wait_event_type = 'Lock'`) before letting the first commit. There
are no sleeps anywhere in these suites.

The suite also runs the race against the implementation the guard exists to rule
out — read the row, compute the next version in TypeScript, write it — and
watches it destroy a committed write while landing on the same version number,
so the row afterwards does not even show that two updates happened.

One finding is recorded as a test rather than as a fix:
`readConflict` is documented as something to run inside the failed write's
transaction, and the reason given was that the transaction's snapshot is the one
the update ran against. It is not. These routes run at READ COMMITTED, where
every statement takes a fresh snapshot, so a row deleted and committed in
between is reported as `missing` from inside the transaction. The answer is the
better of the two available; the reasoning was wrong, and the comment now says
what actually happens.

### `outbox-store.test.ts`

The two claims `outbox.ts` makes that nothing could previously check.

**Atomicity.** `enqueueOutbox(tx, …)` is only worth anything if the event and
the change it describes commit or roll back together. `pg-proxy` refuses
`transaction()` outright, so nothing had ever rolled one back. Here a handler
inserts a todo, enqueues `todo.created`, and throws — and neither survives.

**`FOR UPDATE SKIP LOCKED`.** The property whose absence is invisible until a
second instance is deployed and every event is published twice. Relay A's claim
is held in an open transaction while relay B claims against it: B gets
_different_ rows, and it gets them _at all_. The control is next to it — the
same statement with `skipLocked` removed, under a 750 ms `statement_timeout`,
which is cancelled by the server (SQLSTATE 57014) having done no work.

This suite found that `UPDATE … RETURNING` has no defined row order and does not
return the subquery's. The claim selects the oldest rows correctly and then
handed them to the relay backwards, which quietly broke the "an idle queue
delivers in commit order" paragraph in `outbox.ts`, since `relayBatch` publishes
the array in the order it is given. `createDrizzleOutboxStore` now sorts the
batch by `created_at` before the relay sees it.

## Adding a suite

Three things bite.

1. **A held transaction occupies its connection.** Every client is opened with
   `max: 1`, which is what makes a client a _session_ — the concurrency tests
   depend on it. A query sent to the same `TestConnection` while it holds a
   transaction does not run alongside that transaction, it queues behind it, and
   if the thing that would release the transaction is further down the same
   test, the suite deadlocks rather than fails. Read held rows from a third
   connection; the suites call it `observer`.

2. **Asking a blocked session whether it is blocked cannot work.**
   `waitUntilBlocked` therefore reports the probe's own pid alongside the answer
   and throws if you hand it the connection you are waiting on. Use the third
   connection for that too.

3. **A Drizzle builder is lazy.** postgres-js puts a query on the wire when
   something subscribes to it, so `const p = builder` leaves the session idle
   and `waitUntilBlocked` waits for a lock nobody is asking for. Start it with
   `(async () => await builder)()`.

Everything else is ordinary: `beforeEach(() => truncateAll(…))` — before, not
after, so a failing test leaves its rows there to be looked at and the next test
still starts clean — and `hold()` for anything that needs a transaction kept
open. `hold()` rolls itself back after 20 seconds if nobody releases it, so an
assertion that throws mid-interleaving costs one test instead of the run.

## What is not covered

- **No route runs here.** These are the stores and the migrations, not
  `server/api/**`: a handler needs a Nitro server, which is `tests/e2e/`'s
  job. The gap that leaves is the wiring — a route that forgot to pass `tx`
  rather than `useDb()` would pass both suites.
- **No index is proven to be used.** `outbox_pending_idx` is asserted to exist
  with its predicate intact. Whether the planner picks it is a question about a
  table with rows in it, and on a three-row fixture the answer is always a
  sequential scan.
- **`uploads` has one test.** It is in the schema comparison and its unique
  constraint is pinned; the S3 presigning around it is mocked elsewhere.
- **One Postgres major.** The suites run on `postgres:17-alpine`, pinned, and
  do not sweep versions. The behaviour they rest on — row locks, `SKIP LOCKED`,
  READ COMMITTED re-evaluation — has been stable for many majors, but it is
  measured on one.
