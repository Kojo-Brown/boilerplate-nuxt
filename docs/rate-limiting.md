# Rate limiting in Nitro middleware, backed by storage

`server/middleware/30.rate-limit.ts` bounds how often one caller may reach a
route handler. It is the fourth and last link in the middleware chain, it counts
against a shared storage base so the limit means the same thing on every
instance, and it refuses with `429` plus a `Retry-After` a client can act on.

| File                                 | Holds                                               |
| ------------------------------------ | --------------------------------------------------- |
| `server/utils/rate-limit.ts`         | The GCRA algorithm, the settings, the store wrapper |
| `server/utils/rate-limit-policy.ts`  | Which paths are limited, how hard, and whose quota  |
| `server/utils/route-pattern.ts`      | The path matcher, shared with the access policy     |
| `server/middleware/30.rate-limit.ts` | Reading the request, the headers, and the throw     |

## What this is for, and what it is not

Worth settling first, because "rate limiting" names two different jobs and this
is only one of them.

This is an **application** limiter. It bounds how often one caller reaches a
handler, which is what stops credential stuffing against `/api/auth/login`, stops
one client monopolising an expensive endpoint, and makes a quota something the
app can state rather than hope for.

It is **not a DoS defence.** By the time this middleware runs, the request has
been accepted, parsed, routed, and — on a managed path — had its session cookie
unsealed and the session registry consulted. A flood still pays for all of that.
Volumetric defence belongs in front of the application, where a request can be
dropped before it costs anything: an ALB rule, CloudFront, Cloudflare. Putting
this in and calling the problem solved would be the mistake worth avoiding.

## The algorithm: GCRA, not a fixed window

The obvious implementation is a counter per key per window — increment, compare,
expire. It is not what this uses, for a reason that shows up immediately in
production: the **boundary burst**.

A caller limited to 300/minute can send 300 requests in the last instant of one
window and 300 in the first instant of the next. The limit that reads as "300 per
minute" permits 600 inside one second. Every fixed-window limiter has this
property, and it is worst exactly where the limit is smallest and matters most: a
5-per-5-minutes login limit becomes 10 attempts back to back.

So this uses **GCRA** — the Generic Cell Rate Algorithm, which is what
`redis-cell` implements and what a leaky bucket describes. It stores one number
per bucket: the _theoretical arrival time_, or TAT, the moment the bucket would
next be empty if nothing else arrived.

```
emissionInterval = window / limit        // the steady rate
tolerance        = window                // burst allowance == limit

tat     = max(storedTat ?? now, now)     // a drained bucket starts from now
newTat  = tat + emissionInterval         // this request's cost
allowAt = newTat - tolerance             // when there is room for it

if (now < allowAt)  refuse, and store nothing
else                allow, and store newTat
```

Three properties fall out of that, and all three are why it was chosen:

- **No boundary burst.** There is no window to sit on the edge of. The bucket
  refills continuously, so "5 per 5 minutes" admits a burst of 5 and then one
  more per minute — never 10 at once.
  `tests/unit/server/rate-limit.test.ts` asserts this directly.
- **`Retry-After` is exact.** `allowAt - now` _is_ the time until there is room,
  in closed form, so the number sent to the client is the truth rather than "try
  again when the window rolls over". A test waits exactly the advertised delay
  and checks the next request is admitted.
- **One number per bucket.** Cheaper than a fixed window, which needs a count
  _and_ a window start to report `Reset` honestly, and far cheaper than a
  sliding-window log, which stores a timestamp per request.

A refused request **stores nothing**, which is the other half of the shaping: a
caller hammering a closed bucket does not push their own recovery further away.

## The policy table

`server/utils/rate-limit-policy.ts`, same shape and same matching as
`server/utils/access-policy.ts` — an exact path or a `/**` prefix, most specific
key wins, through the shared matcher in `server/utils/route-pattern.ts`.

```ts
'/**':                      null                             // not limited
'/api/**':                  { limit: 300, windowSeconds: 60 }
'/api/auth/login':          { limit: 5,   windowSeconds: 300 }
'/api/auth/**':             { limit: 20,  windowSeconds: 60 }
'/api/auth/csrf':           { limit: 60,  windowSeconds: 60 }
'/api/vitals':              { limit: 120, windowSeconds: 60 }
'/api/uploads/presign':     { limit: 20,  windowSeconds: 60 }
'/api/cached/invalidate':   { limit: 5,   windowSeconds: 60 }
'/api/ws/ticket':           { limit: 30,  windowSeconds: 60 }
```

`null` means "not limited", and it is what the catch-all carries: pages, Nuxt
payloads and build assets are left alone. Same reasoning `access-policy.ts` gives
for leaving them `unmanaged` — a limiter on every `.js` chunk would add a storage
round trip to every asset a page loads, and the thing worth protecting is the API
behind them.

The API default is deliberately generous: a ceiling a person cannot reach and a
scraper or a runaway retry loop can. The interesting entries are the ones that are
tighter, and each carries its reason in the source. The tightest is
`/api/auth/login` — 5 per 5 minutes, per IP. A person who has forgotten their
password tries three or four times and then resets it; an attacker working a
leaked credential list needs thousands and gets 60 an hour. The window is long
rather than the limit small on purpose: a short window at the same rate would let
the list be worked in bursts.

**The limits are code, not environment variables.** There is no
`NUXT_RATE_LIMIT_API_LIMIT`. Each number is a judgement about what an endpoint
costs and what abusing it buys, and a judgement belongs next to its reason where a
reviewer can disagree with it — the same argument `access-policy.ts` makes for its
carve-outs. `tests/unit/server/rate-limit-policy.test.ts` walks `server/api/` and
fails if an exact key stops naming a route that exists, so a limit cannot outlive
the endpoint it was written for.

## Whose quota: the identity

A bucket is keyed by the **rule that matched** plus the **caller** — so two route
groups never share a counter, and one endpoint cannot exhaust another.

The caller is their user id when they have a session, and their IP address when
they do not:

- **User id first.** A signed-in caller behind a shared NAT — an office, a
  university, a mobile carrier — should not be throttled by their neighbours, and
  a signed-in abuser should not escape their quota by changing address.
- **IP when anonymous,** because there is nothing else. This covers the limits
  that matter most: `/api/auth/login` has no session by definition.

The cost of preferring the user id, stated plainly: an attacker holding N valid
sessions gets N quotas. That is the right trade — accounts are expensive to
obtain, IP addresses are not — but it means a per-account limit is a _fairness_
control and the anti-abuse limits are the IP-keyed ones.

### `x-forwarded-for`, and the bypass this avoids

This is the setting that decides whether the limiter can be bypassed at all, so it
is worth understanding rather than copying.

`x-forwarded-for` is a list each proxy **appends** to. A request that arrives at a
load balancer already carrying `x-forwarded-for: 9.9.9.9` — because the _client_
sent it — is forwarded as `9.9.9.9, <real client ip>`. So:

> The leftmost entry is whatever the client claimed. The rightmost entries are the
> ones infrastructure you control wrote.

h3's own `getRequestIP(event, { xForwardedFor: true })` takes
`.split(',').shift()` — the **leftmost**, client-controlled entry. Key a limiter
on that and any caller mints an unlimited supply of fresh buckets by varying one
header. That is why this app does not use that helper and counts hops from the
right instead.

`NUXT_RATE_LIMIT_TRUST_PROXY_HOPS` is therefore **how many proxies sit in front of
this app**:

| Value           | Reads                                     | When                                |
| --------------- | ----------------------------------------- | ----------------------------------- |
| `0` _(default)_ | the socket's peer address, header ignored | `pnpm dev`, anything reached direct |
| `1`             | the last `x-forwarded-for` entry          | one load balancer                   |
| `2`             | the second from last                      | a CDN in front of a balancer        |

The default is `0` because it is the only value that is never _wrong_ — it cannot
be spoofed. It can be **unhelpful**: behind a proxy every caller arrives from the
balancer's address and shares one bucket, which looks from the outside like the
limiter refusing traffic at random. So a built server warns once per process when
it is left at `0`:

```
[rate-limit] counting requests by socket address because NUXT_RATE_LIMIT_TRUST_PROXY_HOPS
is 0. If this server sits behind a load balancer or CDN, every caller shares the
proxy's bucket — set it to the number of proxies in front of the app.
```

That asymmetry is the whole design: an operator who has to be told to count their
hops gets a limiter that is too strict and a log line explaining why. An operator
silently handed the client's own header gets a limiter that does nothing.

The address is also whitelisted before it is used — hex digits, dots and colons —
because an entry from this header becomes part of a storage key and a log line.
A chain shorter than the configured hop count falls back to the socket, since that
means either a misconfigured count or a request that reached the app without
passing the proxy.

## What goes on the wire

Every limited response carries the allowance, whether or not it was refused:

```
RateLimit-Limit: 5
RateLimit-Remaining: 0
RateLimit-Reset: 60
RateLimit-Policy: 5;w=300
Retry-After: 60          ← only on a 429
```

`Retry-After` (RFC 9110) is the only one of these that is actually standardised,
and the only one worth relying on in a client. The `RateLimit-*` triple is the
shape from **draft-05** of `draft-ietf-httpapi-ratelimit-headers`, which is what
is widely deployed and what HTTP client libraries look for. Later drafts replace
the triple with a single structured `RateLimit` field; that is deliberately not
emitted, because no client reads it yet and a header nothing consumes is a header
that goes stale without anyone noticing.

The 429 body carries a machine-readable code, so a client can tell this from any
other refusal:

```json
{
  "statusCode": 429,
  "message": "Rate limit exceeded: 5 requests per 300s. Retry in 60s.",
  "data": {
    "code": "RATE_LIMITED",
    "limit": 5,
    "windowSeconds": 300,
    "retryAfterSeconds": 60,
    "requestId": "…"
  }
}
```

## Where it sits in the chain

| File                                      | Runs | Does                                          |
| ----------------------------------------- | ---- | --------------------------------------------- |
| `server/middleware/00.request-context.ts` | 1st  | Request id, arrival time                      |
| `server/middleware/10.auth.ts`            | 2nd  | Session → `event.context.auth`, access policy |
| `server/middleware/20.csrf.ts`            | 3rd  | Refuses a request that cannot show its origin |
| `server/middleware/30.rate-limit.ts`      | 4th  | Refuses a caller who is asking too often      |

Two orderings are defensible and this one is deliberate.

It runs **after auth** because that is what makes a per-user quota possible at
all: `event.context.auth` does not exist until `10.auth.ts` has resolved it. The
cost is real — a flood still pays for session unsealing and the registry read
before being refused — which is exactly why this is not a DoS defence.

It runs **after CSRF** because that gate is two header reads and at most one HMAC,
and because its answer is more specific: a forged request should be told it was
forged (403), not that it was too frequent. Quota is for requests that are
otherwise legitimate.

## The storage base

One more base on Nitro's storage, `rate-limit`, mounted on Redis alongside
`cache`, `sessions` and `idempotency` when `NUXT_REDIS_URL` is set. See
[docs/nitro-storage.md](./nitro-storage.md).

A fourth base rather than a prefix on `cache` for the same reason `idempotency` is
its own: flushing the cache namespace to force a re-render must not also reset
every login-attempt counter in the deployment.

It carries **no driver-level TTL**. Each write sets its own, computed from that
bucket's drain time, so a key is reclaimed exactly when it stops meaning anything.
Only the Redis driver honours `ttl` — the built-in memory and fs drivers ignore it,
so on a no-Redis deployment these keys accumulate for the life of the process.
That is harmless for correctness, since a stored timestamp in the past reads as a
drained bucket, but it is one reason Redis is the configuration this feature is
meant to run on.

The other reason is the limit itself: **without Redis, N per window becomes N per
window per instance.** Two instances behind a load balancer mean an effective
login limit of 10 per 5 minutes, not 5. The boot warning in
`server/utils/storage.ts` says so.

## The race this does not close

`unstorage` has no compare-and-set and no atomic increment — no `SETNX`, no
`INCR`, nothing atomic across its drivers.
[docs/idempotency.md](./idempotency.md) documents the same gap. So
`consumeRateLimit` is a read, a decision, and a write, and two requests that
interleave as read(A), read(B), write(A), write(B) both see the older TAT — one of
them costs the bucket nothing.

Stated plainly: **under genuinely concurrent arrivals this limiter can admit more
than the limit.** The overshoot is bounded by how many requests fit inside one
storage round trip, which is sub-millisecond on a local Redis.

Unlike idempotency, that is an acceptable trade rather than a reluctant one, and
the difference is worth naming. A duplicated payment is a wrong outcome no amount
of averaging fixes. A limiter is a statistical control: it exists to bound a rate
over time, a lost increment costs a fraction of one window's allowance, and the
next arrival reads the written TAT and is shaped normally. A login limiter that
admits 6 attempts instead of 5 in a dead heat still stops credential stuffing; a
fixed-window one that admits 10 _by design_ does not — which is the comparison
that matters.

Closing it entirely needs `ioredis` directly — a Lua script, or `INCR` plus
`EXPIRE` — which would give up the memory-driver test path and the no-Redis
deployment mode with it. That is the trade, recorded rather than implied.

## Failure is open

An unreachable store is logged and the request proceeds. Same stance, and the same
reasoning, as the session registry in `server/middleware/10.auth.ts`: fail-closed
would make Redis a hard dependency of _serving at all_, turning a cache blip into a
total outage. Fail-open costs exactly what the app had before this feature existed.

No `RateLimit-*` headers are set in that case, deliberately — a
`RateLimit-Remaining` this request never established would be a number the client
is entitled to believe.

## Verified against the built server

Not inferred from the source — `node .output/server/index.mjs`, with
`NUXT_RATE_LIMIT_TRUST_PROXY_HOPS` unset.

`/api/auth/login` is a state-changing route, so the CSRF gate at `20.` refuses it
before the limiter at `30.` is reached — a token-less `curl` loop gets seven 403s
and never exercises this feature at all. That ordering is itself the first thing
worth confirming. With a real token from `/api/auth/csrf`:

```
$ for i in $(seq 1 7); do
    curl -s -b jar -o /dev/null -w '%{http_code} ' \
      -X POST http://127.0.0.1:3000/api/auth/login \
      -H 'content-type: application/json' -H "x-csrf-token: $TOKEN" \
      -H 'origin: http://127.0.0.1:3000' \
      -d '{"email":"a@b.test","password":"wrong-password"}'
  done
401 401 401 401 401 429 429
```

Five attempts reach the handler (401 — wrong password) and the sixth is refused
before it gets there. The 429, captured immediately after the burst:

```
HTTP/1.1 429 Too Many Requests
ratelimit-limit: 5
ratelimit-remaining: 0
ratelimit-reset: 300
ratelimit-policy: 5;w=300
retry-after: 60
```

`Retry-After: 60` is the emission interval — one attempt refills a minute after the
burst is spent — and `Reset: 300` is when the bucket is empty again. Read a minute
later the same refusal reports `retry-after: 44` and `ratelimit-reset: 284`, which
is the point of GCRA: both numbers are continuous, not a window boundary.

That these headers survive `createError` at all is the thing worth checking rather
than assuming — headers set on the event before the throw are preserved by Nitro's
error handler. The status message is stated explicitly for the same reason: Nitro
defaults an unrecognised status to `Server Error`, so without it a 429 goes out
reading `HTTP/1.1 429 Server Error`.

The body carries the machine-readable code:

```json
{
  "statusCode": 429,
  "message": "Rate limit exceeded: 5 requests per 300s. Retry in 60s.",
  "data": {
    "code": "RATE_LIMITED",
    "limit": 5,
    "windowSeconds": 300,
    "retryAfterSeconds": 60,
    "requestId": "062a2929-887c-4c3c-bf2a-ee56e0ea5da0"
  }
}
```

A spoofed header changes nothing at the default hop count — same socket, same
bucket:

```
$ curl … -H 'x-forwarded-for: 9.9.9.9' -X POST .../api/auth/login
429
```

Restarted with `NUXT_RATE_LIMIT_TRUST_PROXY_HOPS=1`, the trusted hop is read and
the client's own prefix is ignored. Client A varies the spoofed entry on every
request; client B is a different address behind the same balancer:

```
A (varying spoof, real 192.0.2.10):  401 401 401 401 401 429
B (same balancer, 192.0.2.20):       401
```

A cannot escape its bucket by rewriting the header, and B is unaffected by A
having exhausted theirs. Counting from the left — which is what h3's
`getRequestIP({ xForwardedFor: true })` does — would have admitted all six of A's.

An ordinary API request carries its allowance:

```
$ curl -si http://127.0.0.1:3000/api/route-rules/cors | grep -i ratelimit
ratelimit-limit: 300
ratelimit-remaining: 299
ratelimit-reset: 1
ratelimit-policy: 300;w=60
```

And both boot warnings appear as written — the storage one naming `rate-limit`
among the per-process bases, and:

```
[rate-limit] counting requests by socket address because NUXT_RATE_LIMIT_TRUST_PROXY_HOPS
is 0. If this server sits behind a load balancer or CDN, every caller shares the
proxy's bucket — set it to the number of proxies in front of the app.
```

It is silent once the hop count is set.

## Adding a limit

1. Add a key to `rateLimitRules` **with a reason**, next to the number. An exact
   path beats a wildcard, so a carve-out needs no reordering.
2. If it is an exact key, it must name a handler that exists under `server/` —
   `tests/unit/server/rate-limit-policy.test.ts` enforces that.
3. Think about whose bucket it should be. An endpoint reachable without a session
   is IP-keyed, which is the case that actually resists abuse.
4. Do not reach for an environment variable. The limit is a judgement, and it
   belongs next to its reasoning.

## Turning it off

`NUXT_RATE_LIMIT_ENABLED=false` returns before any store access. Useful for a load
test against the app itself, and for nothing else — note that the string `"false"`
is recognised explicitly, because that is what an environment variable actually
delivers and a truthiness check would leave the limiter on.
