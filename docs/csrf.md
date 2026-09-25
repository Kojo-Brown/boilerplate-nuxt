# CSRF: the origin check and the signed double-submit token

The session is a sealed, `httpOnly`, `SameSite=Lax` cookie
([docs/session-security.md](./session-security.md)). That makes it **ambient
authority**: the browser attaches it because of where a request is _going_,
never because of where it came _from_. So any page anywhere that can cause this
app's origin to receive a `POST` causes it to receive an _authenticated_ `POST`.

`server/middleware/20.csrf.ts` is what stops that. It runs on every request,
after the auth middleware, and refuses any state-changing one that cannot show
it came from this origin.

## Why `SameSite=Lax` is not the end of it

Lax does most of the work, and it is worth being precise about what it leaves.

- **Same site, different origin.** `https://cdn.app.test` and
  `http://app.test:3000` are the same _site_ as `https://app.test`, so their
  requests carry the cookie. A subdomain someone else controls — a marketing
  page, a staging box, a bucket with a CNAME — is a working CSRF vector that the
  cookie attribute says nothing about. This is the main thing the gate adds.
- **Clients that do not implement it.** Lax is a browser behaviour, not a server
  check, and a server has to answer for the clients that ignore it.
- **Lax is not Strict.** A top-level cross-site _navigation_ does send the
  cookie. Nothing under `/api` changes state on `GET`, which is what makes that
  survivable — and that invariant is `SAFE_METHODS` in `types/csrf.ts` rather
  than a list anyone keeps in their head.

## The two checks

Both must pass. They fail independently, which is the point of having two.

### 1. Where the request came from

Read from `Sec-Fetch-Site`, falling back to `Origin`.

| Signal                        | Verdict                                      |
| ----------------------------- | -------------------------------------------- |
| `Sec-Fetch-Site: same-origin` | allowed                                      |
| `Sec-Fetch-Site: none`        | allowed — no page initiated it               |
| `Sec-Fetch-Site: same-site`   | **refused** unless the origin is allowlisted |
| `Sec-Fetch-Site: cross-site`  | **refused** unless the origin is allowlisted |
| `Origin` matching the host    | allowed                                      |
| `Origin` on the allowlist     | allowed                                      |
| any other `Origin`            | refused                                      |
| neither header                | **refused** — see below                      |

`Sec-Fetch-Site` is preferred because a page cannot set it: the browser computes
it from the relationship between initiator and target and forbids script from
touching it. `Origin` is compared by **host**, not by full origin, because TLS
is terminated at a proxy far more often than not — a page on `https://app.test`
reaches a handler whose own `Host` says `app.test` over plain `http`. An
allowlist entry _is_ matched on the full origin, scheme and port included,
because an operator wrote that entry to name one specific sibling.

**A state-changing request with neither header is refused.** Every browser sends
`Origin` on a request whose method is not `GET` or `HEAD` — form posts included,
`sendBeacon` included, in any CORS mode — so its absence means the caller is not
a browser and is therefore not subject to CSRF at all. Those callers are also
the ones that can set the header trivially. Refusing costs them one line and
costs an attacker the whole vector. If you are the caller:

```sh
curl -X POST http://localhost:3000/api/todos \
  -H 'origin: http://localhost:3000' \
  -H "x-csrf-token: $TOKEN" \
  -b "csrf=$TOKEN" \
  -H 'content-type: application/json' -d '{"title":"from curl"}'
```

### 2. A signed double-submit token

A value in a cookie, echoed back in `x-csrf-token`. A cross-origin page can
cause a request but cannot **read** this origin's cookies, so it cannot produce
the header.

Two properties make this more than the classic double-submit:

- **It is a MAC**, under a key derived from `NUXT_SESSION_PASSWORD` with HKDF
  (`server/utils/csrf-config.ts`, `info: nuxt-csrf-double-submit-v1` — the same
  construction as the WebSocket ticket key, and a different context string, so
  the two keys are unrelated). A plain double-submit accepts any value that
  appears in both places; this one cannot be invented.
- **The cookie is `__Host-` prefixed** on every TLS request. A browser only
  accepts that prefix on a cookie that is `Secure`, has `Path=/` and carries no
  `Domain` — which is exactly what makes it unsettable by a sibling host. So the
  token cannot be _planted_ either.

Between them, forging a token needs the signing key and stealing one needs code
running on this exact origin, which is XSS — at which point CSRF is not the
problem you have.

The expiry is inside the MAC, so it travels in the clear and still cannot be
edited. The token is **not** bound to the session or the user: the `__Host-`
prefix already closes the attack binding would defend against, and binding would
tie the token's validity to session id rotation, which replaces that id every
fifteen minutes — invalidating good tokens on a schedule in exchange for nothing.

### The cookie is readable by scripts, on purpose

`httpOnly` is `false` here and only here. The mechanism depends on a script on
_this_ origin reading the value and echoing it in a header, which is precisely
what a cross-origin script cannot do. A token nobody can read is a token nobody
can submit. It is also not a credential: on its own it authenticates nothing,
and only the pair of it and the session cookie — which stays `httpOnly` —
authorises anything. `tests/unit/lint/token-storage.test.ts` has the longer note.

## Where tokens come from

The middleware writes the cookie on the response to a **document** request — an
ordinary page load — and nowhere else. The narrowness is deliberate: a
`Set-Cookie` on anything cacheable would hand one visitor's token to everyone
the cache serves next, and this app has three kinds of cached response
(`swr`/`isr` route rules, `defineCachedEventHandler` under `/api/cached/**`, and
every asset under `/_nuxt/`). Restricting issuance to documents leaves only one
exclusion to make — shared HTML, which `servesSharedHtml` already derives from
`route-rules.config.ts` for the CSP nonce, for the same reason.

Everything else gets a token from `GET /api/auth/csrf`, served `no-store`:

```json
{ "token": "aXQtaXMtcmFuZG9t.mhqcrk.t0ptcjb…", "expiresIn": 43200, "header": "x-csrf-token" }
```

That route covers a visitor whose first page was prerendered, a tab that has
been navigating client-side for longer than the token's life, and any
non-browser consumer. A caller that already holds a good token gets that same
token back rather than a new one, so two tabs cannot race the cookie jar.

## The browser side

`utils/csrf.ts` reads the cookie and produces the header.
`utils/api.ts` does it for everything going through the `/api` client — which is
`useApi()` and the HTTP todo gateway, so most of the app's writes — and the
remaining raw `$fetch` writes spread `csrfRequestInit()` into their options:

```ts
await $fetch('/api/auth/login', {
  method: 'POST',
  body: { email, password },
  ...(await csrfRequestInit()),
})
```

There is no interceptor installed on the global `$fetch` that would do this
everywhere. `$fetch` is bound out of `#build/fetch.mjs` when the module using it
is _evaluated_, so a plugin replacing it later would already have lost the race
for half the app. The cost is a line per write. What it buys is that the
mechanism is greppable, and that forgetting it fails closed and loudly — a 403
on the first `pnpm dev` click, not a hole that ships.

During SSR there is no `document`, so `csrfRequestInit()` returns `{}` and
spreading it is a no-op.

## What a refusal looks like

```http
HTTP/1.1 403 Forbidden

{
  "statusCode": 403,
  "message": "Missing x-csrf-token. Echo the CSRF cookie in it on every state-changing request.",
  "data": { "code": "CSRF_REJECTED", "reason": "missing-header", "requestId": "…" }
}
```

`data.code` is stable; `data.reason` is one of `cross-origin`, `no-origin`,
`missing-cookie`, `missing-header`, `mismatched-token`, `token-expired`,
`token-invalid`, `token-malformed`. The messages are specific because every one
of them is something an integrator has to be able to fix, and none tells an
attacker anything they could not learn by trying.

## Exemptions

`CSRF_ORIGIN_ONLY_PATHS` in `server/utils/csrf.ts` lists the routes checked on
origin alone. There are two:

- **`/api/vitals`** — `navigator.sendBeacon` is the only send that survives a
  page unloading and it cannot attach a header. A beacon does carry `Origin`, so
  the strong check still applies; what is given up is the layer that would
  survive a proxy stripping it, on a route whose worst case is a forged
  performance metric bounded by the closed enums in
  `server/utils/vitals-schemas.ts`.

- **`/api/_auth/session`** — `nuxt-auth-utils`' own route. Its `DELETE` is what
  `useUserSession().clear()` calls, from inside the module's composable, through
  a `useRequestFetch()` this app has no seam to add a header to. What is given up
  is bounded: CSRF on a sign-_out_ is a forced logout, not an action taken as the
  victim, and the origin check still refuses it from any page that is not this
  one. The write that actually ends a session server-side is `/api/auth/logout`,
  which is this app's own route and is not exempt.

`tests/unit/server/csrf.test.ts` asserts every exemption still names a live
route, so one cannot outlive the endpoint it was opened for — the same guard
`access-policy.test.ts` puts on the public carve-outs.

## Settings

| Variable                               | Default | Notes                                                      |
| -------------------------------------- | ------- | ---------------------------------------------------------- |
| `NUXT_SECURITY_CSRF_TOKEN_TTL_SECONDS` | `43200` | Clamped to 300…604800. Re-issued at half life.             |
| `NUXT_SECURITY_CSRF_ALLOWED_ORIGINS`   | unset   | Comma-separated. The request's own host is always allowed. |

There is deliberately no separate CSRF secret. The key is derived from
`NUXT_SESSION_PASSWORD`, and a token whose lifetime is already bounded gains
nothing from rotating independently of it except another variable that can be
left unset.

## Verified against the built server

Not `pnpm dev`. The transcript below is against `node .output/server/index.mjs`
with `NUXT_SESSION_PASSWORD` set. `/api/auth/login` rather than `/api/todos`
because the gate runs _after_ `10.auth.ts`: a forged request to a protected route
is answered 401 first, which is the right answer to it.

```sh
# A page load hands out the cookie — readable, Lax, no Domain.
curl -si -H 'sec-fetch-dest: document' localhost:3000/login | grep -i '^set-cookie: csrf'
# set-cookie: csrf=eNRmNRf1fQsyHBaEGmSFIw.tlxk3k.YDz1oKBvTOuMe4h-…; Max-Age=43200; Path=/; SameSite=Lax

curl -sX POST localhost:3000/api/auth/login -H 'origin: https://evil.test' | jq -c .data
# {"code":"CSRF_REJECTED","reason":"cross-origin","requestId":"…"}

curl -sX POST localhost:3000/api/auth/login -H 'origin: http://localhost:3000' | jq -c .data
# {"code":"CSRF_REJECTED","reason":"missing-cookie","requestId":"…"}

curl -sX POST localhost:3000/api/auth/login | jq -c .data
# {"code":"CSRF_REJECTED","reason":"no-origin","requestId":"…"}

# The cookie without the matching header proves nothing: that is the whole point.
curl -s -b jar.txt -X POST localhost:3000/api/auth/login \
  -H 'origin: http://localhost:3000' -H 'x-csrf-token: wrong' | jq -c .data
# {"code":"CSRF_REJECTED","reason":"mismatched-token","requestId":"…"}

curl -s -c jar.txt localhost:3000/api/auth/csrf
# {"token":"JXdfjCGJ5syeTHIJjuCRRw.tlxk3k.8ZcJ7mb0gxx…","expiresIn":43200,"header":"x-csrf-token"}

curl -s -b jar.txt -X POST localhost:3000/api/auth/login \
  -H 'origin: http://localhost:3000' -H "x-csrf-token: $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"email":"admin@example.com","password":"password123"}'
# {"ok":true}
```

## Limits worth knowing

- **A server with no seal key does not run the gate.** It warns once and lets
  requests through. That is not leniency: with no key there are no sealed
  sessions, so there is no ambient authority to borrow. A deployment that is
  actually serving cannot reach it — `server/plugins/session-hardening.ts`
  refuses to boot without a key.
- **`Referer` is not a fallback.** It is stripped by privacy tooling and by
  `Referrer-Policy: no-referrer`, so accepting it means accepting a header
  legitimate traffic often lacks and requiring it means breaking that traffic.
  `Origin` carries the same information and is not suppressed on writes.
- **An intermediary that strips `Origin` breaks every write.** The token half
  still passes; the site check reports `no-origin` and refuses. That is the
  intended failure — fail closed — and the fix is at the proxy.
- **WebSocket upgrades are not covered here.** They never build an `H3Event`, so
  no middleware sees them; the handshake carries its own gate. See
  [docs/websockets.md](./websockets.md) and `server/utils/ws-handshake.ts`.
- **Over plain HTTP the cookie loses its prefix.** `__Host-` requires `Secure`,
  and Safari has historically refused `Secure` cookies over `http://`, so a
  non-TLS request gets the unprefixed `csrf` name. Same token, same
  verification, one property less — and no deployment behind TLS ever sees it.
