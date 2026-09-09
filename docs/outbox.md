# Transactional outbox and relay

A handler writes a row and then wants to tell something else — a search indexer,
a webhook, an email worker. Two systems, one handler, and no transaction spans
both:

```ts
await db.insert(todos).values({ title }) // committed
await fetch(webhook, { … })              // …and this throws
```

The todo exists and nobody was told. Swapping the order is the opposite bug: the
webhook fires for a todo the database never kept. There is no ordering of a
commit and a network call that makes them atomic, and a retry loop around the
second one only narrows the window — the process can still be killed between
them.

The outbox turns the two writes into one. The event becomes a **row in the same
database**, written in the same transaction as the change it describes, so the
commit makes both true at once. A separate loop reads those rows afterwards and
publishes them.

| File                                   | What it is                                                                     |
| -------------------------------------- | ------------------------------------------------------------------------------ |
| `server/db/schema.ts`                  | The `outbox` table and its partial index.                                      |
| `server/utils/outbox.ts`               | The rules: settings, backoff, one relay pass, the poll loop. No Nitro, no SQL. |
| `server/utils/outbox-store.ts`         | The Drizzle half: `enqueueOutbox` and the four statements the relay runs.      |
| `server/utils/outbox-publisher.ts`     | Where a claimed row goes — an HTTP webhook, or the log in dev.                 |
| `server/utils/todo-events.ts`          | The three todo events and their payloads.                                      |
| `server/plugins/outbox-relay.ts`       | The Nitro seam: starts the relay at boot, stops it at shutdown.                |
| `server/db/migrations/0001_outbox.sql` | The table, for a database that is not managed by `drizzle-kit push`.           |

## Producing an event

Take the `tx`, not `useDb()`:

```ts
const created = await db.transaction(async (tx) => {
  const [row] = await tx.insert(todos).values({ title }).returning()
  if (!row) throw createError({ statusCode: 500, message: 'Failed to create todo' })
  await enqueueOutbox(tx, [todoCreatedMessage(row)])
  return row
})
```

`enqueueOutbox` accepts a `Database` as readily as a transaction — a
`PgTransaction` is a `PgDatabase` — so the type will not stop you writing the row
on the connection instead. That row commits even when the change it describes
rolls back, which is the failure the outbox exists to prevent, reintroduced from
the inside. If the handler needs a transaction anyway, this is free; if it does
not, adding one is the price of the guarantee.

The three todo routes do this today. `[id].delete.ts` is the case that needs it
most: the row is gone after the commit, so a `todo.deleted` not written in the
same transaction could never be reconstructed afterwards — there is nothing left
to reconstruct it from.

## Consuming one

The relay POSTs each event to `NUXT_OUTBOX_WEBHOOK_URL`:

```http
POST /hooks/outbox HTTP/1.1
content-type: application/json
idempotency-key: 0f8c…                 ← the outbox row id, stable across retries
x-outbox-event: todo.created

{
  "id": "0f8c…",
  "type": "todo.created",
  "aggregate": { "type": "todo", "id": "22222222-…" },
  "occurredAt": "2026-01-01T00:00:00.000Z",
  "attempt": 1,
  "payload": { "id": "22222222-…", "title": "…", "completed": false, … }
}
```

Anything but a 2xx is a failure and will be retried. `occurredAt` is when the
producing transaction committed, not when this attempt was made.

## What is guaranteed, and what is not

**At least once, never exactly once.** The relay publishes and then marks the row
delivered. Those are two systems again, and the same argument that motivated the
outbox applies to them: a process that dies between them republishes on the next
pass. Nothing in this design can close that.

What it does instead is make the duplicate cheap to absorb. Every delivery
carries the row id as an `Idempotency-Key` — the same header this app's own
mutating routes accept (`docs/idempotency.md`), so a consumer built on this
boilerplate puts its ingest route behind `defineIdempotentHandler` and is done.
Exactly-once is a property of the pair; the id is the producer's half.

**Ordered when idle, not under failure.** A batch is claimed in
`available_at, created_at` order and published sequentially, so a healthy queue
delivers in commit order. A failed event is rescheduled _behind_ events that
committed after it. Preserving order under failure would mean stopping the queue
at the first failure, and one unreachable consumer would then hold up every other
event in the table. Consumers that need per-aggregate ordering compare the
payload's `updatedAt` rather than trusting arrival order.

**No sweep of an interrupted publish.** A relay killed between the POST and the
mark leaves a row that looks unpublished, and it will be published again. That is
the at-least-once statement above, seen from the operator's side.

## How the relay claims work

Every server instance runs a relay and they all poll the same table. That is the
design: the claim is one statement, so instances divide the queue between
themselves.

```sql
UPDATE outbox SET attempts = attempts + 1, available_at = $lease
 WHERE id IN (SELECT id FROM outbox
               WHERE published_at IS NULL AND failed_at IS NULL
                 AND available_at <= $now
               ORDER BY available_at, created_at
               LIMIT $limit
                 FOR UPDATE SKIP LOCKED)
RETURNING *
```

`FOR UPDATE` locks the selected rows; `SKIP LOCKED` makes a competing relay step
over them and take the next ones instead of blocking behind a lock held for the
length of somebody else's HTTP request. Without the pair, two relays either
serialise the whole queue or claim the same rows.

Pushing `available_at` out to `now + claimLeaseMs` in the same statement is what
makes a claim survivable. The row is not "locked" once the statement commits — it
is merely _not due yet_, so a relay killed mid-publish releases it by expiry,
with no reaper to run and no lock held across a network call.

`attempts` is incremented by the claim, before the publish is tried. A payload
that reliably crashes the relay therefore dead-letters after `maxAttempts`
instead of being retried forever by every instance in turn. The cost is that a
relay restarted mid-batch spends attempts on rows it never published; at the
default of 10, that is a queue that tolerates nine crashes.

## Retries and dead letters

A failed delivery is rescheduled at `base × 2^(attempts − 1)`, capped at
`maxBackoffMs`, with jitter over the **upper half** of that window. The jitter
matters because every relay in a deployment fails at the same instant when a
consumer goes down, and an undithered backoff marches the whole fleet to the same
retry instant — the consumer's first moment back up is then a thundering herd.
The jitter is not full-range: full jitter's short draws are indistinguishable
from no backoff at all, which against a service that is already down is a hot
loop.

After `maxAttempts`, `failed_at` is set and the row leaves the partial index for
good. It is a dead letter, not a deletion: the row is the only record that an
event was owed and never delivered, and its payload is what an operator replays
by hand.

```sql
-- what is stuck, and why
SELECT id, event_type, attempts, last_error, failed_at
  FROM outbox
 WHERE failed_at IS NOT NULL
 ORDER BY failed_at DESC;

-- replay one, once the consumer is fixed
UPDATE outbox
   SET failed_at = NULL, attempts = 0, available_at = now(), last_error = NULL
 WHERE id = '…';
```

A delivered row is kept too. It is the audit trail of what was emitted, and
deleting on success would make "no row" mean both "delivered" and "never
enqueued". Pruning is a retention decision, so it is an operator's statement
rather than something the relay does:

```sql
DELETE FROM outbox WHERE published_at < now() - interval '30 days';
```

## Configuration

Everything is optional and everything is clamped — see `server/utils/outbox.ts`
for the bounds and `.env.example` for the list.

| Variable                               | Default  | What it is                                       |
| -------------------------------------- | -------- | ------------------------------------------------ |
| `NUXT_OUTBOX_WEBHOOK_URL`              | unset    | Where events are POSTed.                         |
| `NUXT_OUTBOX_RELAY_ENABLED`            | `true`   | Enqueue but do not deliver, when `false`.        |
| `NUXT_OUTBOX_RELAY_POLL_INTERVAL_MS`   | `1000`   | Idle wait. A full batch polls again immediately. |
| `NUXT_OUTBOX_RELAY_BATCH_SIZE`         | `20`     | Rows per claim.                                  |
| `NUXT_OUTBOX_RELAY_BASE_BACKOFF_MS`    | `1000`   | First retry delay.                               |
| `NUXT_OUTBOX_RELAY_MAX_BACKOFF_MS`     | `300000` | Retry-delay ceiling, floored at the base delay.  |
| `NUXT_OUTBOX_RELAY_MAX_ATTEMPTS`       | `10`     | Attempts before a dead letter.                   |
| `NUXT_OUTBOX_RELAY_CLAIM_LEASE_MS`     | `30000`  | How long a claim holds a row.                    |
| `NUXT_OUTBOX_RELAY_PUBLISH_TIMEOUT_MS` | `5000`   | Per-delivery timeout.                            |

Three boot states, decided by `resolveOutboxRelayPlan`:

- **`http`** — a webhook is configured. Deliver.
- **`log`** — `pnpm dev` with no webhook. Log each event instead of delivering
  it, so the whole path is observable against nothing but a database.
- **`disabled`** — no database, the off switch, or a **built** server with no
  webhook. The last of those warns at boot: routes keep writing outbox rows, so
  nothing is lost, but nothing is delivered either and the table will grow.

A built server never gets `log` mode. A relay that marks rows delivered without
delivering them reports a drained queue while every consumer starves.

A deployment that would rather run the relay somewhere else sets
`NUXT_OUTBOX_RELAY_ENABLED=false` on the web instances and leaves it on for one.
The routes keep enqueuing either way — that half is a database transaction, not a
background job.

## The relay loop

Three properties, each of which is a bug in the obvious version:

- **No overlap.** A `setTimeout` chain, not `setInterval`: the next poll is
  scheduled after the previous one finishes. An interval shorter than a pass —
  which is every interval, once a consumer starts timing out — stacks passes
  until the batches meet each other.
- **Drains without waiting.** A pass that filled its batch polls again
  immediately, since a full batch means rows were left behind. Only an under-full
  pass sleeps, so a backlog drains at the consumer's speed rather than at
  `batchSize` per `pollIntervalMs`.
- **Shuts down at once.** The sleep is cancellable, so `close` does not wait out a
  poll interval, and the pass in flight finishes marking its rows delivered
  rather than being cut off after publishing them. The timer is `unref`ed, so a
  relay that is somehow never stopped cannot be why a process refuses to exit.

A pass that throws — a consumer that is down, a database that is unreachable — is
logged and retried on the next poll. It never reaches a request.

## What the tests cover, and what they cannot

`tests/unit/server/outbox.test.ts` runs the relay against an in-memory queue that
implements the same claim semantics — due-only, lease, limit, ordering — so the
retry schedule, the dead-letter threshold, the lease expiry and the loop's three
properties are all asserted against real behaviour rather than a mock.

`tests/unit/server/outbox-store.test.ts` drives the **real** Drizzle query
builder through the `pg-proxy` driver, which takes a callback in place of a
connection, and reads the SQL it emits. That is how `FOR UPDATE SKIP LOCKED` is
pinned: a claim missing it passes every functional test on one process and starts
double-publishing the day a second instance is deployed, so there is no
single-connection test that can tell the two apart.

Two things are out of reach without a live database, and neither is claimed
anywhere in the code:

- **Postgres actually honouring the lock** under two concurrent relays.
- **The transactions themselves** — that a rolled-back handler leaves no outbox
  row. `pg-proxy` refuses `transaction()` outright.

Both want Testcontainers, which is its own `SPEC.md` item.
