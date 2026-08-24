# Nitro route rules

Route rules are Nitro's per-route contract for **how a route is rendered and
cached**. They are declared once, keyed by request path, and applied by Nitro to
both pages and `server/` API routes — the rule matches the URL, not the file
that serves it.

This boilerplate keeps the whole table in [`route-rules.config.ts`](../route-rules.config.ts)
(imported by `nuxt.config.ts`) so it is a single, unit-tested source of truth
rather than an inline blob in the config. The tests live in
[`tests/unit/route-rules.test.ts`](../tests/unit/route-rules.test.ts).

## The four rules demonstrated

| Rule        | Declared as           | Demo route              | What it does                                                                                                                                              |
| ----------- | --------------------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `prerender` | `{ prerender: true }` | `/route-rules/static`   | Rendered once at build, written to `.output/public/…/index.html`, served as a static file with no server compute.                                         |
| `swr`       | `{ swr: 30 }`         | `/api/route-rules/swr`  | Cached 30s; requests inside the window get the cached copy, the first request after it gets the stale copy while a background render refreshes the cache. |
| `isr`       | `{ isr: 60 }`         | `/api/route-rules/isr`  | Incremental Static Regeneration — see the preset note below.                                                                                              |
| `cors`      | `{ cors: true, … }`   | `/api/route-rules/cors` | Emits `Access-Control-Allow-Origin/Methods/Headers` so another origin can `fetch()` the route.                                                            |

The rule overview page at `/route-rules` fetches the three API endpoints live so
you can watch the caching behaviour, and links to the prerendered page.

## SWR vs ISR — and why the preset matters

`swr` and `isr` express nearly the same intent — _serve a cached copy and
regenerate it in the background_ — but they resolve differently depending on the
Nitro **preset** (the deploy target):

- **`swr`** is handled by Nitro's own cache layer. It works everywhere,
  including the **Node preset** this project builds with (`nuxt build` →
  `node .output/server/index.mjs`). This is the rule to reach for when you want
  caching on a long-running Node server.

- **`isr`** is the idiomatic Nuxt API for handing regeneration to the deploy
  platform. On **serverless/edge presets** (Vercel, Netlify) it maps to
  platform-native ISR: the platform caches the first render on its CDN and
  regenerates at most once per interval. On the **Node preset** `isr` is
  recognised as a cacheable route (its payload is extracted at build) but is not
  itself a runtime cache — so on a plain Node server the ISR demo endpoint is
  effectively uncached. Use `swr` for Node-side caching.

Both endpoints return the same shape and stamp each render with a timestamp, so
the difference is observable: on the Node build, the SWR endpoint's `renderedAt`
freezes for its 30-second window while the ISR endpoint's advances every request.

## Prerendering and the auth middleware

A prerendered page is rendered at build time with **no request session**. The
app-level `auth.global` middleware redirects unauthenticated visitors to
`/login`, and that redirect fires during prerendering too — a gated page
prerenders to a `<meta http-equiv="refresh" url="/login">` stub instead of the
real page.

So the prerender demo lives on a **public path**: `/route-rules` and
`/route-rules/static` are listed in `PUBLIC_PATHS` in
[`middleware/auth.global.ts`](../middleware/auth.global.ts). They are _not_
guest-only, so a signed-in user sees them too — only the login/register forms
bounce an authenticated user away.

The dynamic index carries `{ prerender: false }` so the prerender crawler does
not follow the back-link from the static page and freeze the live SSR page into a
static snapshot.

## Verifying it yourself

Route-rule _runtime_ behaviour is Nitro's, not something a unit test can assert
without a running server, so verify it against the real build:

```bash
# Prerender: the static file is emitted at build time
NUXT_SESSION_PASSWORD=dev-only-session-password-min-32-chars pnpm build
cat .output/public/route-rules/static/index.html   # real page, not a /login redirect

# Start the built Node server
NUXT_SESSION_PASSWORD=dev-only-session-password-min-32-chars node .output/server/index.mjs &

# SWR: renderedAt is frozen inside the 30s window
curl -s localhost:3000/api/route-rules/swr
curl -s localhost:3000/api/route-rules/swr   # same renderedAt

# CORS: the Access-Control-Allow-* headers are present
curl -sI localhost:3000/api/route-rules/cors | grep -i access-control
```

## Adding a rule

1. Add the path and rule to `route-rules.config.ts` with a comment saying why.
2. If it is a page that must render without a session (e.g. `prerender`), add its
   path to `PUBLIC_PATHS`.
3. Add an assertion to `tests/unit/route-rules.test.ts` so the contract is pinned.
