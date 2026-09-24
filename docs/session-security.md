# Session security: httpOnly cookies, sealed sessions, rotation

How a signed-in request proves who it is, what stops that proof being stolen or
reused, and which of those properties the server will refuse to start without.

Three files do the work, and each one answers a different question:

| File                                | Question                                                   |
| ----------------------------------- | ---------------------------------------------------------- |
| `server/utils/session-hardening.ts` | Is the cookie configured so only the browser can use it?   |
| `server/utils/session-store.ts`     | Can a live session be ended before it expires?             |
| `server/utils/session-rotation.ts`  | Does the credential change, and does the sign-in ever end? |

## The credential

`nuxt-auth-utils` issues a **sealed cookie**. The session — the user object and
the two timestamps below — is serialised, encrypted and signed with
`NUXT_SESSION_PASSWORD` by `iron-webcrypto`, and the resulting string is the
cookie value. Nothing about the user is stored server-side, which is what lets
the app scale to any number of instances with no shared session state, and is
also why revocation and rotation need the machinery they do.

There is no token endpoint. `useAuth()` returns the user, never a credential, and
no part of the client ever holds something it could put in `localStorage`.
`tests/unit/lint/token-storage.test.ts` scans every file that ships to the
browser and fails if that changes.

## httpOnly cookies only

`nuxt.config.ts` sets `session` from `HARDENED_SESSION_TRANSPORT`:

```ts
sessionHeader: false,
cookie: { httpOnly: true, secure: true, sameSite: 'lax', path: '/' },
```

Only the first of those changes h3's behaviour — the four cookie attributes match
what h3 and the auth module already default to. They are stated anyway, because
`server/plugins/session-hardening.ts` compares the **resolved** config against
them at boot and refuses to start if anything is weaker. Every one of these is
overridable at runtime with a `NUXT_SESSION_*` variable, and a deployment that
weakens one should fail loudly rather than serve.

`sessionHeader: false` is the one that was not already true. h3 reads a sealed
session out of an `x-nuxt-session-session` request header before it looks at the
cookie, unless that flag is exactly `false`. A header is not httpOnly: a client
could keep the sealed blob in web storage and replay it there, which is precisely
the pattern "httpOnly cookies only" rules out.

The `false` is load-bearing as a _boolean_. h3 tests `!== false`, so the string
`"false"` — which is what an environment variable becomes when Nuxt cannot infer
the type — leaves the header path wide open while reading, in any config dump, as
though it were closed. The boot check tests for that case by name.

`sameSite: 'lax'` rather than `'strict'` because the GitHub OAuth callback is a
cross-site top-level navigation that has to arrive with the cookie. `'strict'` is
accepted by the boot check if a deployment does not use OAuth.

## The seal key

`NUXT_SESSION_PASSWORD` must be at least 32 characters, must not contain any of
the placeholder markers from `.env.example`, and must use at least ten distinct
characters. Generate one with:

```sh
openssl rand -base64 32
```

A **missing** key is fatal in a built server, and a warning in `pnpm dev` (the
module generates one and writes it to `.env`) and while prerendering (`pnpm
build` on a machine with no secrets is a supported thing to do). A key that is
present and weak is fatal everywhere, dev included — there is no environment in
which a placeholder is the right seal key. Without this check, nuxt-auth-utils
logs an error and carries on, and the failure surfaces on the first sign-in as an
error about key length.

## Rotation

### The id that rotates is not h3's

h3's `session.id` cannot be rotated, and the API hides that.
`replaceUserSession` calls `useSession().clear()` and then `update()`; `clear()`
drops the session from `event.context`, and the next read rebuilds it by
unsealing **the cookie the request is still carrying**, recovering the same id —
which is then truthy, so no new one is minted. Verified against h3 1.15.11:

```
set     -> { id: 'd48c9e6a-…' }
replace -> { before: 'd48c9e6a-…', after: 'd48c9e6a-…', same: true }
```

So the session carries its own identifier, `sid`, minted by this app. That is
what the registry is keyed on, what sign-in mints fresh, and what rotation
replaces. `readCredentialId()` in `server/utils/request-auth.ts` is the single
place that answers "which id", and it falls back to h3's for a cookie sealed
before `sid` existed.

### The two clocks

Two timestamps ride inside the seal, so a client cannot move its own deadline:

- **`issuedAt`** — when this person last actually authenticated. Carried across
  every rotation.
- **`rotatedAt`** — when the current `sid` was minted. Reset by rotation.

`server/middleware/10.auth.ts` reads them on every managed request and does one
of three things.

**Rotate** (`rotatedAt` older than `intervalSeconds`, 15 minutes by default).
`replaceUserSession` mints a new id and reseals, the new id is registered, and
the old one is retired after a grace window. What this buys is bounded: a cookie
captured an hour ago stops working, even though its seal is valid for another six
days. What it does not buy: it does not _detect_ the theft, and it does nothing
while the attacker is the one making the requests.

**End** (`issuedAt` older than `absoluteMaxAgeSeconds`, seven days by default).
The record is revoked, the cookie is cleared, and the request gets
`401 Session expired; sign in again`.

Rotation is not what makes that cap necessary, and it is worth being exact about
why, because the usual argument for it does not apply here. h3 keeps `createdAt`
across a reseal just as it keeps the id, so the cookie's `Expires` and the seal's
TTL both stay anchored to when the session was first created — rotation extends
neither. Verified the same way as above: a reseal three seconds later reissued
the cookie with an identical `Expires`. What the cap adds is that the bound
becomes _this app's_: it can be shorter than the cookie's `maxAge`, it revokes the
registry record instead of waiting for a seal to quietly stop verifying, it
answers a named 401 rather than looking like a session that was never valid, and
it does not rest on an h3 implementation detail. It applies with rotation turned
off.

**Nothing**, which is the common case.

Sign-in mints a fresh `sid`, so the identifier the registry works from is never
one the caller was holding beforehand. That is the session-fixation half of the
same idea, and it has to be `sid` rather than h3's id for the reason above.

### The grace window

Rotation is not atomic from the browser's side. A page that fires four requests
at once has three of them in flight with the id the fourth just replaced.
`retireSession` therefore writes a `revokedAt` `graceSeconds` in the future
(30 by default, and always clamped to a quarter of the rotation interval), so
those finish and a later replay does not. The honest cost: for that many seconds
after each rotation, two ids are accepted for one session.

The same race lets several concurrent requests each rotate. That is allowed
rather than locked against — the browser keeps the last `Set-Cookie`, the losing
records expire on their own, and a lock would put a round trip on every
authenticated request to save a few short-lived keys.

### What is not rotated

Rotation happens in the auth middleware, which only runs for paths
`server/utils/access-policy.ts` manages — API traffic, not pages. A session that
only ever loads pages is never rotated. It is still capped, because the cap is
checked in the same place and nothing the app does is page loads alone.

## Settings

All of these are optional and all are clamped. See `.env.example`.

| Variable                                         | Default  | Meaning                                                                                  |
| ------------------------------------------------ | -------- | ---------------------------------------------------------------------------------------- |
| `NUXT_SESSION_PASSWORD`                          | —        | The seal key. Required in a built server.                                                |
| `NUXT_SESSION_MAX_AGE`                           | `604800` | Cookie lifetime and seal TTL, in seconds.                                                |
| `NUXT_SESSION_ROTATION_INTERVAL_SECONDS`         | `900`    | How old an id may get. `0` turns rotation off. Floored at 60, capped at `maxAge`.        |
| `NUXT_SESSION_ROTATION_ABSOLUTE_MAX_AGE_SECONDS` | `604800` | How long one sign-in may last. `0` disables the cap. Floored at the interval.            |
| `NUXT_SESSION_ROTATION_GRACE_SECONDS`            | `30`     | How long a replaced id keeps working. Clamped to 1…300 and to a quarter of the interval. |

## Limits worth knowing

- **Revocation and rotation are only durable if the `sessions` storage base is.**
  On the per-process default driver a restart forgets every `revokedAt`, and a
  revoked cookie works again. Set `NUXT_REDIS_URL`; see `docs/nitro-storage.md`.
- **The registry fails open.** A session with no record is allowed through, and a
  storage error during the revocation check is logged and the request proceeds.
  `server/utils/session-store.ts` explains the trade: fail-closed would make
  Redis a hard dependency of authentication, and a Redis outage would sign
  everyone out at once.
- **A session sealed before rotation existed carries neither timestamp.** It is
  rotated on its next request rather than expired, which adopts it onto the
  scheme — expiring it would sign out every existing user the moment this
  deployed.
- **The boot check reads config, not behaviour.** It cannot tell you that a proxy
  in front of the app strips `Secure`, or that a subdomain is setting cookies on
  the parent domain.
