# Optimistic concurrency with a version column

Two people open the same todo. One marks it done; the other, a minute later,
fixes its title. Both requests succeed, and one of the two changes is gone —
not rejected, not logged, just overwritten by a request that was working from a
copy of the row taken before the first write landed. Nothing in the database
noticed, because as far as it could tell, the second `UPDATE` was simply the
more recent one.

That is the **lost update**, and it is the default behaviour of every
read-modify-write handler that does not guard against it. It does not need
concurrency in the "thousands of requests a second" sense; it needs two people
and a form that takes a minute to fill in.

The fix here is a `version` counter on the row, `If-Match` on the write, and a
dialog for the case where the guard fires.

| File                                     | What it is                                                                                               |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `server/db/schema.ts`                    | The `version` column, and why it is a counter and not `updated_at`.                                      |
| `server/utils/optimistic-concurrency.ts` | `If-Match` / `ETag` parsing and the decision rules. No Nitro import, so it is tested as plain functions. |
| `server/utils/todo-store.ts`             | The guarded statements. This is where the guarantee actually lives.                                      |
| `server/api/todos/[id].patch.ts`         | The status-code translation, and the table of which situation maps to which.                             |
| `server/api/todos/[id].delete.ts`        | Same, plus why a delete needs a precondition too.                                                        |
| `types/todos.ts`, `utils/todoGateway.ts` | `TodoItem.version`, and the one `TodoConflictError` every adapter throws.                                |
| `composables/useTodoList.ts`             | `conflict`, `keepMine`, `keepTheirs` — the decision, as state.                                           |
| `components/TodoConflictDialog.vue`      | The conflict UI.                                                                                         |

## The mechanism, end to end

```
GET  /api/todos/42            →  200  ETag: "4"     { …, "version": 4 }

PATCH /api/todos/42           →  200  ETag: "5"     the row is now at 5
  If-Match: "4"

PATCH /api/todos/42           →  412                somebody wrote first
  If-Match: "4"                     { "current": { …, "version": 5 },
                                      "expected": 4, "actual": 5 }
```

The write that enforces it is one statement:

```sql
UPDATE todos
   SET completed = $1, updated_at = $2, version = todos.version + 1
 WHERE id = $3 AND version = $4
RETURNING *
```

Two clients that both read version 4 cannot both succeed. Whichever commits
first moves the row to 5; the other matches no row, and the route answers 412
rather than silently discarding the first write.

### The check has to be in the statement

This is the whole thing, and it is easy to get subtly wrong:

```ts
// WRONG — this has moved the race, not closed it.
const [row] = await db.select().from(todos).where(eq(todos.id, id))
if (row.version !== expected) throw createError({ statusCode: 412 })
await db.update(todos).set(values).where(eq(todos.id, id))
```

The comparison and the write are two statements, and a competing transaction
fits between them. Both clients read version 4, both find it equal to what they
expected, and both update. The guard has to be part of the statement that
writes, which is why `server/utils/todo-store.ts` exports the statements rather
than exposing an `assertVersion(expected, actual)` helper that would read just
as convincingly at the call site.

`version = todos.version + 1` is computed in SQL for the same family of reason.
Writing `version: expected + 1` from the value we were handed is correct only
because the `WHERE` already pinned the row to `expected` — a coincidence that
stops holding the moment somebody adds a caller that does not pass one.

## Why a counter and not `updated_at`

`updated_at` is already on the row and looks like it would do the job. It does
not:

- Two updates inside the same microsecond are indistinguishable.
- `now()` is the **transaction's** start time in Postgres, so two concurrent
  transactions can stamp the same instant no matter how long each takes.
- A clock that goes backwards — an NTP step, a restored backup, a promoted
  replica — makes a stale token compare as fresh.

A counter the database increments has none of those properties to lose. It is
also a value a human can read: `If-Match: "4"` is a bug report on its own.

## Why not a lock

`SELECT … FOR UPDATE` also makes the two writes safe, by making the second one
wait. That is the right tool when conflicts are frequent and the holder releases
quickly.

It is the wrong tool across _think time_ — the minute between a user opening a
form and submitting it. The lock would have to be held by a database transaction
spanning two HTTP requests, so the user who wandered off to lunch blocks
everyone else, and a client that crashes mid-edit holds the row until the
connection is reaped. Optimistic control costs nothing in the common case and
makes the rare case a decision, which is the trade every collaborative editor
makes.

## Status codes

| Situation                   | Status | Why                                                                  |
| --------------------------- | ------ | -------------------------------------------------------------------- |
| No `If-Match`               | 428    | RFC 6585 §3. The request is well-formed, just unconditional.         |
| Unparseable `If-Match`      | 400    | The client has a bug. A silently ignored precondition would hide it. |
| Row is gone                 | 404    | There is no target resource — the same answer `GET` gives.           |
| Row exists at a new version | 412    | RFC 9110 §13.1.1 — a failed `If-Match` on a state-changing request.  |

409 Conflict is the other status in common use, and it is the right one for an
API that carries the expected version **in the request body**. Here the
precondition is a conditional request in the sense the HTTP specification
defines, so 412 is the status that already means it — and it keeps a version
conflict distinguishable from the 409 `defineIdempotentHandler` answers while a
request with the same `Idempotency-Key` is still in flight.

### The precondition is required, not optional

`PATCH` and `DELETE` reject a request with no `If-Match`. Accepting both would
hand every client the ability to opt out of the guarantee — including by
forgetting — and the clients that forget are exactly the ones that will lose an
update.

`If-Match: *` is accepted and means "whatever version it is, as long as it
exists". It is still one statement and still cannot lose to a concurrent delete;
it simply does not care which version it overwrites. It is the right header for
a script doing a bulk correction, and the wrong one for a user-facing edit.

### The 412 carries the current row

```json
{
  "statusCode": 412,
  "message": "This todo has changed since you loaded it: you have version 4, it is now at version 5.",
  "data": { "current": { "id": "…", "title": "…", "version": 5 }, "expected": 4, "actual": 5 }
}
```

Sent with the error rather than left for the client to fetch. A re-read would
cost a round trip at the exact moment the client is already behind, and it opens
a second race: it can land after _another_ edit, so the conflict UI would show a
third version that neither writer ever saw.

The re-read that produces it runs **inside the failed write's transaction**, so
it answers from the snapshot the update ran against rather than from whatever
the table looks like a moment later.

## The client half

`TodoItem` carries `version`, and it is part of the domain type rather than a
transport detail the adapter hides. The caller is what has to supply it — a
write says which version it believed it was changing, and only the code holding
the item knows that:

```ts
await gateway.setCompleted(todo.id, true, todo.version)
```

Every adapter throws the same `TodoConflictError`. The HTTP adapter maps a 412
(and a 404, which is the same situation with nothing to merge against) onto it;
the in-memory adapter raises it from its own version check. A consumer therefore
handles conflicts identically against a database and against a fixture.

`createConflictingTodoGateway` is how the path is reached on demand — a
decorator over the port, like `createFaultyTodoGateway`, that makes a write lose
a race it never had. Producing a genuine conflict needs two clients writing
between one client's read and its write, which is impossible against a
single-threaded in-memory store and awkward against a real one. Only the
collision is staged: what it throws is the real error type, so everything
downstream of it is exercised for real. The **Conflicting** adapter on
`/dependency-inversion` is this, wired to a three-step script.

### The decision, as state

`useTodoList` keeps a conflict separate from `error`, because it is not one. An
error is something that went wrong and that a retry might fix. A conflict is a
write that was refused for a good reason, and only a decision settles it:

```ts
const { conflict, keepMine, keepTheirs } = useTodoList()
```

- **`keepMine()`** re-applies the change on top of _their_ row, not by re-sending
  the caller's snapshot — that snapshot describes a version that no longer
  exists, so writing it back would revert whatever else they changed while
  intending only to change one field. It goes through the same guarded write as
  the original, so it can conflict again: a third client may have written while
  the user was deciding, and a resolver that skipped the guard would be the one
  unguarded write in the application.
- **`keepTheirs()`** discards this client's change and adopts the stored row.
  Dismissing the dialog does the same thing, deliberately: the list is known to
  be behind the moment a conflict is raised, and a "cancel" that left the stale
  row on screen would leave the user looking at a todo whose next write is going
  to be rejected for exactly the same reason.

When the other client **deleted** the row, `keepMine` is not offered. Recreating
it would be a different decision from "keep my change" — new id, every other
client's reference to it stale — so the dialog says there is nothing to merge
with and offers only to drop it.

## Not covered

- **Field-level merging.** The dialog shows both versions and takes one of them
  whole. A real merge (their title, my completed flag) is a product decision
  per field, and a generic implementation of it would be a worse answer than
  the two honest buttons.
- **A live feed of other people's edits.** A conflict is discovered at write
  time. `server/api/streaming/` and the outbox in `docs/outbox.md` are what a
  version of this that updated the list as others typed would be built on;
  `todo.updated` already carries `version` for exactly that consumer.
- **Postgres actually enforcing the guard.** `tests/unit/server/todo-store.test.ts`
  pins the SQL — that `AND version = $n` is emitted and that the bump is
  computed in SQL — through Drizzle's `pg-proxy` driver, which is the property
  no functional test on one connection can distinguish. Two real connections
  racing on a real database is the Testcontainers item in `SPEC.md`. It was
  checked by hand against a local Postgres 16 while this was written: two
  sessions both read version 1, the second `UPDATE` blocked on the first's row
  lock, and on re-evaluating its predicate after that commit it reported
  `UPDATE 0` — the first write survived, the second was refused rather than
  silently applied. That is `READ COMMITTED` re-checking the `WHERE` against the
  new row version, and it is the behaviour the whole scheme rests on.
- **The routes themselves, in CI.** The unit suite covers the header rules, the
  statements, the adapters and the controller; the handlers that join them have
  no automated test, because there is no database in CI to run one against —
  the same gap `docs/idempotency.md` and `docs/outbox.md` record, and the same
  Testcontainers item closes all three. The whole sequence was run by hand
  against the built server and a local Postgres 16 while this was written, and
  every status below is what came back:

  | Request                            | Answer                                         |
  | ---------------------------------- | ---------------------------------------------- |
  | `POST /api/todos`                  | `201`, `ETag: "1"`, `version: 1` in the body   |
  | `GET /api/todos/:id`               | `200`, `ETag: "1"`                             |
  | `PATCH` with no `If-Match`         | `428`                                          |
  | `PATCH` with `If-Match: W/"1"`     | `400`, naming the weak tag                     |
  | `PATCH` with `If-Match: "1"`       | `200`, `ETag: "2"`                             |
  | `PATCH` again with `If-Match: "1"` | `412`, `expected: 1`, `actual: 2`, current row |
  | `DELETE` with `If-Match: "1"`      | `412`                                          |
  | `DELETE` with `If-Match: "2"`      | `204`                                          |
  | `PATCH` the deleted row            | `404`, `current: null`                         |

  The outbox ended with `todo.created` at version 1, `todo.updated` at 2 and
  `todo.deleted` at 2 — the refused writes emitted nothing, which is the
  transaction boundary doing its job.

- **`If-None-Match` and conditional reads.** The `ETag` is written for writes.
  Serving a 304 from it is a caching concern and would interact with the route
  rules in `docs/nitro-route-rules.md`.
