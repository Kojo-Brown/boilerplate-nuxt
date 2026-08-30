# Nitro storage, the Redis driver, and the session registry

Nitro gives every server process one `unstorage` instance, reachable from server
code as `useStorage()`, with named **bases** mounted onto it. This app cares
about two:

| Base       | Written by                                                                                                      | Backed by                                    |
| ---------- | --------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| `cache`    | Nitro itself — `swr` / `isr` route rules and `defineCachedEventHandler` — plus the tag index in `cache-tags.ts` | Redis when configured, per-process otherwise |
| `sessions` | This app — `server/utils/session-store.ts`                                                                      | Redis when configured, per-process otherwise |

Both are mounted at **runtime** by `server/plugins/storage.ts`, from a plan that
`server/utils/storage.ts` computes out of `runtimeConfig`.

## Why runtime and not `nuxt.config.ts`

Nitro accepts a `storage` key in `nuxt.config.ts`, and that is the documented way
to mount a driver. It is the wrong way here, for the reason already written at
the top of `runtimeConfig` in that file: **that config is serialised into the
build**. A Redis URL written there — or read there from `process.env`, which is
the same mistake with an extra step — is baked into `.output/` and ships with the
image. One build would then be pinned to one Redis.

So the URL is `runtimeConfig.redis.url`, set by `NUXT_REDIS_URL` at run time like
every other credential in this project, and the mount happens during Nitro
startup, before the first request. One image, any Redis.

## Configuration

| Variable                | Default | Meaning                                                     |
| ----------------------- | ------- | ----------------------------------------------------------- |
| `NUXT_REDIS_URL`        | _unset_ | `redis://…` or `rediss://…`. Unset means no Redis.          |
| `NUXT_REDIS_KEY_PREFIX` | `nuxt`  | Key prefix, so both bases can share one Redis database.     |
| `NUXT_REDIS_CACHE_TTL`  | `0`     | Hard ceiling in seconds on any cache key. `0` = no ceiling. |

Keys land as `<prefix>:cache:…` and `<prefix>:sessions:…`. Two deployments can
share a Redis by taking different prefixes.

`docker-compose.yml` runs a Redis with `--appendonly yes` and wires
`NUXT_REDIS_URL` for the app service, so `docker compose up` gets the configured
path without any extra step.

### Unconfigured is supported. Misconfigured is fatal.

With `NUXT_REDIS_URL` unset, **nothing is mounted** and both bases keep whatever
Nitro gave them: an fs directory under `.nuxt/` in dev, memory in a built server.
That is correct for `pnpm dev`, for `pnpm test`, and for a single instance, and
it is why the app boots with no Redis at all. A built server in that state logs
one warning at startup saying its cache and sessions are per-process; dev does
not, because there it is the intended setup.

A URL that is **set but unusable** is the opposite case, and
`resolveStorageMounts` throws rather than falling back. Falling back would hand
an operator a server that boots, passes staging, and then silently runs two
independent caches and two independent session registries in production. A
refusal to start names the variable and the problem; it never echoes the URL,
because a Redis URL carries a password and boot errors go to the logs.

## What mounting `cache` on Redis actually fixes

`cache` is not this app's base — Nitro writes to it. The `swr` and `isr` route
rules in `route-rules.config.ts` store their cached payloads there, and so will
`defineCachedEventHandler` when it lands.

Before this, "cached for 60 seconds" meant _per process_. A two-instance
deployment had two independent caches, so a client could see a 60-second-old
response and a fresh one alternately depending on which pod answered, and a
rolling restart threw the whole cache away. On Redis the entry is written once
and read by every instance.

The mount deliberately sets **no default TTL** on `cache`. Nitro stores each
entry's `maxAge` inside the value and prunes on read; a driver-level expiry would
be a second, shorter clock it does not know about. `NUXT_REDIS_CACHE_TTL` exists
for operators who want a hard ceiling on how long any key may occupy Redis, and
is off by default.

## The session registry

`nuxt-auth-utils` sessions are **sealed cookies**. The session lives in the
browser, encrypted with `NUXT_SESSION_PASSWORD`; the server stores nothing. That
is what lets this app scale to N instances with no shared session state — and it
is also why, before the `sessions` base existed, a session could not be ended
early. `clear()` asks the browser to drop its cookie. A copy taken beforehand
keeps working until `maxAge` elapses, and nothing on the server could say
otherwise.

`server/utils/session-store.ts` is the "otherwise": one record per session,
keyed `<userId>:<sessionId>`, carrying a `revokedAt`.

- **Sign-in** (`api/auth/login.post.ts`, `routes/auth/github.get.ts`) writes the
  record. The id only exists once `setUserSession` has minted it, which is why
  registration follows the call rather than being part of it.
- **Sign-out** (`api/auth/logout.post.ts`) sets `revokedAt`, then clears the
  cookie. `scope: 'all'` revokes every session that user has — this is the
  "sign out of all devices" the registry exists to make possible, and it is why
  the key leads with the user id: it is a prefix scan of one user's keys, not a
  scan of the store.
- **Every authenticated request** (`server/middleware/10.auth.ts`) reads the
  record and rejects a revoked one with 401, clearing the cookie on the way out.

The record's TTL matches the cookie's `maxAge`, so a record cannot outlive the
cookie it describes and an abandoned session is reclaimed by Redis rather than by
a cleanup job. Revoking re-derives the TTL from the remaining lifetime rather
than letting the tombstone inherit the mount default, which would be longer than
the session had left.

### Missing means unknown, not denied

An absent record is `unknown`, and the middleware lets `unknown` through. This is
fail-open, deliberately:

- Fail-closed makes Redis a hard dependency of **authentication**. An outage
  would not degrade the app, it would sign out every user simultaneously — and
  the operator too.
- Fail-closed would also invalidate every session issued before this registry
  existed, and every session issued while `NUXT_REDIS_URL` was unset.
- Fail-open costs what the app already had: a stolen cookie is valid until it
  expires. Revocation is a capability added on top, not a gate that was working
  and is now leaky.

The same stance covers a store that is unreachable mid-request: the middleware
logs and serves the request. The cookie, not this store, is what grants access —
`server/utils/request-auth.ts` has said so since the middleware item, and that is
still true.

### The costs, stated plainly

- **One storage read per authenticated request** on a managed path. On Redis that
  is a round trip. It is skipped entirely for anonymous callers and for
  `unmanaged` paths, so page and asset traffic is untouched.
- **Revocation is only as durable as the base.** On the per-process default
  driver a restart forgets every `revokedAt` and a revoked cookie works again.
  The memory driver also ignores `ttl`, so records accumulate for the life of the
  process. Neither matters in dev; both are why the startup warning exists.

## Deployment checklist

1. Set `NUXT_REDIS_URL` on every instance. More than one instance without it
   means split caches and unreliable revocation.
2. Use `rediss://` outside a private network — the URL carries the password.
3. Give the session registry durability (`--appendonly yes`, or a managed Redis
   with persistence). Losing the cache on restart costs a few slow requests;
   losing the registry silently un-revokes every signed-out session.
4. Give each deployment sharing a Redis its own `NUXT_REDIS_KEY_PREFIX`.
5. Watch the startup log for the per-process warning. It is the one line that
   says the deployment is not configured the way it is documented.

## Adding another base

Add the constant and its mount to `server/utils/storage.ts`, and its TTL policy
with it. The plugin applies whatever the plan contains, so nothing else changes;
`tests/unit/server/storage.test.ts` covers the plan, and a new base wants a case
there saying what backs it and why.
