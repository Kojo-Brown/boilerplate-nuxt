# Server middleware, the typed `H3Event` context, and request-scoped auth

Everything in `server/middleware/` runs on **every request Nitro handles**,
before any route handler, in **filename order**. That is the whole mechanism —
there is no registration step and no ordering config, which is why the two files
here are numbered:

| File                                      | Runs | Does                                                                       |
| ----------------------------------------- | ---- | -------------------------------------------------------------------------- |
| `server/middleware/00.request-context.ts` | 1st  | Resolves a request id, stamps the arrival time, echoes `x-request-id`      |
| `server/middleware/10.auth.ts`            | 2nd  | Resolves the session into `event.context.auth`, enforces the access policy |

Rename `00.request-context.ts` to `request-context.ts` and it sorts _after_
`10.auth.ts`, which would leave the 401 thrown in the auth middleware with no
request id to report. The numbers are load-bearing.

Middleware that returns `undefined` does not handle the request — it falls
through to the next one and eventually to the route. Neither file here returns a
value except by throwing, so they are context setup and a gate, nothing else.

## Why the gate is here and not in the page middleware

`middleware/auth.global.ts` is a **Vue Router guard**. It decides which pages a
browser may navigate to, it ships in the client bundle, and it has never applied
to anything under `server/` — the note in `route-rules.config.ts` has said so
since the route-rules item. It is a UX affordance: it turns a protected
navigation into a redirect to `/login` instead of a broken screen.

It is not a gate. `curl http://localhost:3000/api/todos` never runs a router
guard. Before this item, every route under `server/api/` answered anyone who
asked. That is what `server/middleware/10.auth.ts` fixes.

The two are complements and both are needed. The router guard gives a logged-out
visitor a login form instead of a 401; the server middleware makes the 401 true.

## The access policy

`server/utils/access-policy.ts` is the table, and it is **default deny**:

```ts
'/**':                  'unmanaged'      // pages, payloads, assets
'/api/**':              'authenticated'  // ← the default for the API surface
'/api/auth/**':         'public'
'/auth/**':             'public'
'/api/route-rules/**':  'public'
'/api/rendering/**':    'public'
```

Adding a route under `server/api/` and forgetting about auth produces a 401, not
an open endpoint. Every hole in that default is an explicit key with a reason
written next to it in the source.

### The three outcomes

- **`authenticated`** — the session is resolved and a request without a user is
  rejected with 401 before the handler runs.
- **`public`** — the session is still resolved, so a handler _may_ personalise
  its response, but a request without one is served normally.
- **`unmanaged`** — the auth middleware does not touch the request and
  `event.context.auth` is never set. This is page and asset traffic; unsealing
  the encrypted session cookie for every `.js` chunk would be pure overhead, and
  Nuxt's own session plugin and the route guard already cover pages.

### Why some API routes have to stay public

Two of the carve-outs are not conveniences, they are consequences of caching:

- `/api/route-rules/**` is cached by Nitro (`swr`, `isr`) and read cross-origin
  (`cors`). A cached response is shared by every caller, so it must not depend on
  who asked for it; a CORS endpoint is by definition for callers with no cookie
  on this origin.
- `/api/rendering/**` is read during the SSR of `/rendering/isr`, whose HTML is
  itself cached for 60 seconds. The render that fills that cache happens on
  behalf of whoever missed it first, so there is no user to forward.

This is the same constraint `docs/nitro-route-rules.md` records for prerendered
pages: **a response that is cached or prerendered cannot be per-user**. If a
route needs a session, it cannot carry a cache rule, and vice versa.

### Matching, and why it is a security boundary

A key is either an exact path or a prefix ending in `/**`, and the most specific
match wins — longest prefix, exact beating wildcard on a tie. Same rou3-style
semantics as `routeRules`, so the two tables read alike.

The path it matches against is `normalisePathname(event.path)`, never `event.path`
itself. The two must agree with what the router resolves, because anywhere they
disagree is a bypass:

```
/api/route-rules/%2e%2e/todos
```

reads as a path under the public `/api/route-rules` prefix and resolves into the
protected `/api/todos`. `normalisePathname` drops the query string, decodes
percent-escapes to a fixed point (so `%252e%252e` is caught as well as `%2e%2e`),
resolves `.` and `..` segments, and strips redundant slashes. Every case above is
in `tests/unit/server/request-path.test.ts` and again, end to end through the
middleware, in `tests/unit/server/middleware.test.ts`.

## The typed context

`server/types/h3.d.ts` augments h3's `H3EventContext`:

```ts
declare module 'h3' {
  interface H3EventContext {
    requestId: string
    requestReceivedAt: number
    auth?: RequestAuth
  }
}
```

Be clear about what this does and does not buy. h3 declares
`interface H3EventContext extends Record<string, any>`, so `event.context.anything`
**already compiled** — and was already `any`. Nothing is unlocked here. What
changes is that these three stop being `any`: `requestId` is a `string` that
cannot be passed where a number is wanted, `auth` narrows through its
`authenticated` discriminant, and an IDE can complete them. A typo in the
property name is the one thing the index signature will still happily accept,
which is exactly why handlers should not reach for `event.context.auth` directly.

## `requireAuth(event)`

```ts
export default defineEventHandler(async (event) => {
  const { user } = requireAuth(event)
  //      ^? User — not User | undefined, no `!`, no cast
})
```

`RequestAuth` is a discriminated union, not `{ user: User | null }`:

```ts
type RequestAuth =
  | { authenticated: false; user: null; sessionId: null }
  | { authenticated: true; user: User; sessionId: string | null }
```

`requireAuth` does the narrowing by throwing, so the common case — a handler
behind an `authenticated` rule — never writes a null check. It throws two
_different_ errors on purpose:

- **401** when the request has no user. An ordinary outcome; the client can act
  on it by logging in.
- **500** when `event.context.auth` was never set at all. That is not the
  caller's problem: it means the handler sits on a path the access policy calls
  `unmanaged`, so no middleware resolved anything. Answering 401 there would send
  a client off to fix a bug it cannot see, so the message names
  `server/utils/access-policy.ts` instead.

That trade — an accessor that throws, rather than a nullable value every call
site has to re-check — is the same one `defineInjection` makes on the app side;
see `docs/provide-inject.md`.

`isAuthenticated(auth)` is the type guard for the handful of places that want to
branch rather than throw (a public route rendering differently when it happens to
know who is calling).

## What resolving auth once actually buys

Not performance. h3's `useSession` caches the unsealed session on
`event.context.sessions`, so calling `getUserSession()` in five handlers already
costs one decrypt, not five. Anyone selling this middleware as a caching win is
selling something that was already there.

What it buys is that the check happens in **one place that cannot be forgotten**,
and that what handlers read is a type whose authenticated case has a non-nullable
`user`.

## SSR data fetching against a protected route

This is the trap that comes with turning the gate on, and it is quiet.

During SSR, a plain `$fetch('/api/posts')` issues a fresh server-side request
that carries **none of the visitor's cookies**. It arrives anonymous, gets a 401,
and `useAsyncData` puts that in `error` rather than throwing — so the page still
returns 200 and simply renders without its data.

`useRequestFetch()` is the fix: it returns a `$fetch` that forwards the incoming
request's headers, so the SSR read is made _as_ the visitor. On the client it is
plain `$fetch`.

```ts
const requestFetch = useRequestFetch()
const { data } = await useAsyncData('posts', () => requestFetch('/api/posts'))
```

`pages/data-patterns.vue` and `pages/upload.vue` both do this now, and the
difference is measurable against the built server. Logged in, requesting
`/data-patterns`:

| SSR fetch           | Response | HTML     | Posts rendered | Metrics panel                              |
| ------------------- | -------- | -------- | -------------- | ------------------------------------------ |
| `useRequestFetch()` | 200      | 13,096 B | yes            | rendered, with its `x-request-id`          |
| plain `$fetch`      | 200      | 10,597 B | no             | stuck on "Loading…", errors in the payload |

Both are 200. That is the point — the failure does not announce itself.

## Correlation ids

`utils/api.ts` has stamped `x-correlation-id` on every browser `$fetch` since the
API-client item, and until now nothing on the server read it, so a browser-side
id and a server-side log line could not be joined up.

`00.request-context.ts` adopts a caller-supplied id from `x-request-id` or
`x-correlation-id` (in that order), mints a UUID when neither is usable, and
echoes the result on the response as `x-request-id`. The 401 thrown by the auth
middleware carries it in `data.requestId`, and `/api/metrics` returns it, so the
same id is visible in the browser, in the response headers, and in the error.

A caller-supplied id is attacker-controlled input headed for a response header
and a log stream, so `isSafeRequestId` whitelists it: alphanumerics plus `.`,
`-`, `_`, 8–128 characters. A UUID and a ULID both fit; a CRLF, a space or a 4 KB
blob does not, and an id that fails is dropped for a minted one rather than
sanitised.

## Verified against the built server

Not inferred from the source — `node .output/server/index.mjs`, unauthenticated:

```
/api/todos                                401
/api/uploads                              401
/api/posts                                401
/api/metrics                              401
/api/route-rules/swr                      200
/api/rendering/info                       200

/api/route-rules/../todos                 401
/api/route-rules/%2e%2e/todos             401
/api/route-rules/%252e%252e/todos         401
/api/todos/                               401
//api//todos                              401
/api/todos?page=1                         401
```

After `POST /api/auth/login` with the demo credentials, `/api/posts` returns 200
and `/api/metrics` returns the `requestId` the caller supplied. `/login`,
`/route-rules` and the prerendered `/route-rules/static` all still render for a
logged-out visitor.

## Adding a route

1. Write the handler under `server/api/`. It is protected by default.
2. If it genuinely must be public, add a key to `serverAccessRules` **with a
   reason**. `tests/unit/server/access-policy.test.ts` walks `server/api/` and
   fails if a public carve-out no longer names a route that exists, so a hole
   cannot outlive the endpoint it was opened for.
3. Read the user with `requireAuth(event)`, not `event.context.auth`.
4. If a page reads it during SSR, use `useRequestFetch()`.
5. If it needs a session, do not give it a `swr`/`isr`/`prerender` route rule.
