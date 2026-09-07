# Idempotency keys on mutating routes

A client sends `POST /api/todos` and the connection dies before the response
arrives. From the outside, "the request never reached the server" and "the todo
was created and the 201 was lost" are the same event. Retrying risks a duplicate;
not retrying risks losing the write. Every HTTP client that retries
automatically — an SDK's backoff, a service mesh, a mobile app resuming on a new
radio — makes that gamble on the caller's behalf, usually without saying so.

An `Idempotency-Key` header settles it. The client mints one id per **logical
operation** and repeats it on every retry of that operation; the server records
the first outcome under that id and replays it to the retries.

| File                               | What it is                                                             |
| ---------------------------------- | ---------------------------------------------------------------------- |
| `server/utils/idempotency.ts`      | The record shapes and the rules. No Nitro dependency, so it is tested. |
| `server/utils/idempotent-route.ts` | `defineIdempotentHandler` — the seam where those meet Nitro.           |
| `server/api/todos/index.post.ts`   | Wrapped. Create is the case a key exists for.                          |
| `server/api/todos/[id].patch.ts`   | Wrapped. Stable response, not a stable effect — see below.             |
| `server/api/todos/[id].delete.ts`  | Wrapped. The 204/404 asymmetry, below.                                 |

The split between the two `server/utils` files is the same one
`cache-tags.ts` / `cached-route.ts` uses: the rules are a pure module tested
against a real in-memory `unstorage`, and the Nitro-dependent half is thin.

## Using it

```ts
// server/api/todos/index.post.ts
export default defineIdempotentHandler(async (event) => {
  const db = useDb()
  const [created] = await db.insert(todos).values({ title }).returning()
  setResponseStatus(event, 201)
  return { data: created, message: 'Todo created successfully', statusCode: 201 }
})
```

From the client:

```bash
curl -X POST http://localhost:3000/api/todos \
  -H 'content-type: application/json' \
  -H "idempotency-key: $(uuidgen)" \
  -d '{"title":"buy milk"}'
```

Repeat the same command — same key, same body — and the second call returns the
first call's 201 and body, with `idempotent-replay: true`, having created
nothing.

## The four answers

| Situation                                       | Status         | Why                                                            |
| ----------------------------------------------- | -------------- | -------------------------------------------------------------- |
| First request under this key                    | the handler's  | Executes normally; `idempotent-replay: false`.                 |
| Same key, same request, first one finished      | the stored one | Replayed verbatim; `idempotent-replay: true`.                  |
| Same key, same request, first one still running | `409`          | With `Retry-After`. Retrying shortly gets the stored response. |
| Same key, **different** request                 | `422`          | A key names one operation. Use a new key.                      |

409 and 422 follow `draft-ietf-httpapi-idempotency-key-header`. A malformed key
is a `400`, and an unreachable dedupe store is a `503` — see below.

The 422 is the one worth dwelling on. Without the fingerprint check, a client
that reuses a key by accident — a constant, or a key derived from a form id
rather than a submission — receives the **first** request's response for the
**second** request's payload, and the write it believes it made never happened.
That failure is silent at every layer, which is why the check is not optional.
The fingerprint is a SHA-256 over the method, the request target and the raw
body, so a key reused on a different route is a 422 too.

## What it is scoped to

The store key is `<user id>:<key>`. Two consequences, both intended:

- One caller's key can never address another's record, so a replay cannot
  disclose a response the caller did not produce. That comes from the key layout
  rather than from a check, which is why the scope leads — the same reason
  `sessionStoreKey` puts the user id first.
- A key is **per caller**, not per route. Reusing one across two endpoints is the
  422 above, not two independent records. Stripe behaves the same way.

The scope is the authenticated user's id, via `requireAuth(event)`. A route the
access policy does not manage has no caller, so wrapping one raises the 500 that
names `server/utils/access-policy.ts` — the shared scope that would otherwise
result is exactly the hole the layout exists to prevent.

## Opt-in per request

A request with no `Idempotency-Key` runs straight through and never touches the
store. The header is the client's declaration that this call is a retry-able unit
of work, and only the client knows that: the same `POST /api/todos` is one
operation when a form is submitted and a different one each time a script loops.

What the server owes in return is that the header is never _silently_ ignored.
`idempotent-replay` is set on **every** response the wrapper handles, `false`
included, so a client can confirm the feature is on before depending on it. A
header that only appeared on replays would make its absence ambiguous between
"freshly executed" and "this route does not do idempotency at all".

## Why all three todo routes, when two are already idempotent

Idempotency of _effect_ and idempotency of _response_ are different properties,
and only the first one comes free:

- **POST** is neither. This is the textbook case.
- **PATCH** setting fields to literal values already has an idempotent effect —
  applying it twice leaves the same row. What a key adds is a stable response:
  the retry returns the first attempt's row rather than one carrying a later
  `updatedAt`, so a client that retries cannot watch the resource change under
  it.
- **DELETE** has an idempotent effect and a **non**-idempotent response: the
  first attempt is a 204 and every one after it is a 404, because the row is
  gone. A client retrying a lost 204 therefore learns that its own delete
  failed. A key makes the retry return the 204 it missed.

Not wrapped, deliberately: `POST /api/auth/login` and `/logout` (replaying a
response would replay a `Set-Cookie`, and the sealed-cookie session already has
its own registry), `POST /api/cached/invalidate` (idempotent in both senses
already), and the upload routes (their effect is in S3, which needs its own
reconciliation rather than a replayed 201).

## What is stored

A record is only ever written for a response the handler **returned normally**
with a 2xx status. Everything else — a thrown `createError`, a 5xx, a status the
handler set itself outside 2xx — releases the claim, so the next attempt
executes.

That is a deliberate simplification. A 4xx from schema validation is a pure
function of the request, so re-executing produces the same 4xx and storing it
buys nothing; a 5xx is exactly the case where a client _should_ get another
attempt. The cost is real and worth naming: **a handler that throws after
committing a side effect will commit it twice on a retry**, and no idempotency
layer that only sees the throw can prevent that. The fix for those handlers is a
transaction, not a bigger record.

Only the status and the body are stored. Response headers are not replayed: they
describe _this_ response — `x-request-id`, `date`, a `Set-Cookie` — and a route
whose headers carry semantics a retry needs should put them in the body.

The stored body is JSON text, so a replayed value has been through a JSON round
trip: a `Date` comes back as the ISO string it was serialised to. Nitro then
serialises that string to exactly the bytes the first caller received, which is
the property that matters and the one
`tests/unit/server/idempotent-route.test.ts` asserts.

## The honest limit: the claim is not a lock

`unstorage` has no compare-and-set — no `SETNX`, nothing atomic across its
drivers. So `claimIdempotency` writes its claim and reads it back, and treats
"the token that came back is not mine" as having lost a race.

That is honest but not airtight. Two requests can still interleave as write(A),
read(A), write(B), read(B) and both proceed. What the read-back buys is the size
of the window. So the guarantee is worth stating exactly:

- **A retry** — the case keys exist for, where the first attempt has already
  reached the store — is deduplicated deterministically.
- **A true dead heat** is narrowed from the handler's whole runtime (a database
  write, tens of milliseconds) to one storage round trip, and is not closed.

Empirically, on the built server: 25 concurrent identical POSTs under one key,
three times over, created exactly one row each time — 23 × 201 (one execution and
22 replays) and 2 × 409 per round. That is evidence the window is small. It is
not proof it is closed, and no number of green rounds would be.

Closing it needs a driver-level `SET key val NX`, which means reaching past
`unstorage` to `ioredis` and giving up the memory-driver test path and the
no-Redis deployment mode with it. That trade is recorded here rather than left
implied.

### Abandoned claims

A process that dies mid-handler leaves an in-flight record behind. Without a
rule, every retry of that operation would get 409 until retention ran out — a day
of a stuck key over a crash the client had nothing to do with. A claim held for
`claimTimeoutSeconds` or longer is therefore treated as abandoned and taken over.

The cost is the case that rule cannot distinguish: a handler genuinely still
running past the timeout looks exactly like a dead one, and its work may be
duplicated. Hence the default of 60 seconds, comfortably longer than any handler
here, and hence the dial.

### An unreachable store fails the request

A claim that cannot be taken is a `503` with `Retry-After`. This is the opposite
of the fail-**open** stance `docs/nitro-storage.md` documents for the session
registry, and the difference is deliberate.

There, the store _adds_ revocation on top of a cookie that already grants access,
so failing open costs exactly what the app had before the registry existed. Here
the store **is** the guarantee. A client sends the header precisely because
executing twice is unacceptable to it; quietly degrading to at-least-once when
Redis blinks would hand it the duplicate it asked not to have, and it would never
know. A 503 is an answer its retry logic already understands, on a request it was
already prepared to repeat.

Requests without the header never consult the store, so an outage does not take
the route down for them.

A failure on the _completion_ write is different: the mutation already happened,
there is nothing to undo, and turning it into a 500 would tell the client its
write failed when it did not. It is logged, loudly, naming the consequence — a
retry of that key will re-execute.

## Configuration

| Variable                                 | Default | Clamped to | Meaning                                       |
| ---------------------------------------- | ------- | ---------- | --------------------------------------------- |
| `NUXT_IDEMPOTENCY_RETENTION_SECONDS`     | `86400` | 60…604800  | How long a completed record stays replayable. |
| `NUXT_IDEMPOTENCY_CLAIM_TIMEOUT_SECONDS` | `60`    | 5…600      | How long an in-flight claim is honoured.      |

Out-of-range values are clamped rather than rejected: both are operational dials
with no correct value this code could know, and a server that refuses to boot
because someone typed a two-week retention is worse than the mistake.

Records live on their own `idempotency` storage base — a third base rather than a
prefix on `cache`, because the two have opposite lifecycles. A cache entry is
_designed_ to be discardable; an operator flushing the cache namespace to force a
re-render must not also erase the record of which operations had already run.
The base is mounted on Redis with the retention window as its TTL, taken from the
same clamped setting the records are written with so the two cannot drift.

**Without `NUXT_REDIS_URL` the base is per-process**, which for this feature is
sharper than for the others: behind a load balancer, a retry that lands on a
different instance finds no record and executes again. The startup warning says
so. See `docs/nitro-storage.md`.

## Not covered

- **No client-side integration.** `utils/api.ts` does not send the header, and
  should not: the server cannot know which calls are one logical operation, and
  guessing would attach a key to loops that need to run every time.
- **No sweep of an interrupted effect.** The record says a handler was entered,
  not what it managed to write. A handler killed mid-transaction leaves the
  database to its own rollback; a handler that writes to two systems needs an
  outbox, not this.
- **No E2E coverage**, in line with the streaming and WebSocket items: the unit
  tests drive the wrapper directly, and the `curl` sequence above was run against
  the built server.
