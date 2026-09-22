# CSP nonces, HSTS, and the rest of the security headers

Every response this app produces carries a security header set, applied by the
`request` hook in [`server/plugins/security-headers.ts`](../server/plugins/security-headers.ts).
The interesting one is `Content-Security-Policy`: it names a per-response nonce,
and the same hook's `render:html` half writes that nonce onto the inline
`<script>` tags Nuxt emits, so the document and the header always come from the
same request.

| File                                 | Job                                                           |
| ------------------------------------ | ------------------------------------------------------------- |
| `server/utils/security-headers.ts`   | The policy, as data. No Nitro, no `H3Event` — pure functions. |
| `server/utils/csp-nonce.ts`          | Minting a nonce, and putting it on the tags that need one.    |
| `server/utils/security-response.ts`  | The `H3Event` glue: mint, decide, set.                        |
| `server/plugins/security-headers.ts` | Registration — the `request` and `render:html` hooks.         |

## What gets sent

```
content-security-policy: default-src 'self'; base-uri 'none'; object-src 'none';
  script-src 'self' 'nonce-ICdt8qflyOyD5I29SbTWSQ=='; style-src 'self' 'nonce-…';
  style-src-attr 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:;
  connect-src 'self'; media-src 'self'; worker-src 'self' blob:; manifest-src 'self';
  frame-src 'none'; frame-ancestors 'none'; form-action 'self';
  upgrade-insecure-requests
strict-transport-security: max-age=31536000; includeSubDomains
x-content-type-options: nosniff
x-frame-options: DENY
referrer-policy: strict-origin-when-cross-origin
permissions-policy: accelerometer=(), autoplay=(), camera=(), …
cross-origin-opener-policy: same-origin
cross-origin-resource-policy: same-origin
```

`Strict-Transport-Security` appears only on a TLS request — decided from
`x-forwarded-proto`, or from the socket when no proxy set one. A browser ignores
the header on plain HTTP anyway, so this changes no behaviour; what it buys is
that `curl -I http://localhost:3000` shows what the browser acts on rather than a
header that reads as active and is not. `upgrade-insecure-requests` is gated the
same way, and there it matters: on a plain-HTTP dev server that directive would
rewrite every `http://localhost` subresource to `https://` and break the page.

`Cross-Origin-Embedder-Policy` is deliberately **not** sent. It is the header
that unlocks `SharedArrayBuffer`, and it costs every cross-origin subresource a
matching `Cross-Origin-Resource-Policy` — including whatever a consumer of this
boilerplate adds later. Shipping it by default would turn an ordinary third-party
`<img>` into a blank box.

## Why a nonce, and why a Nuxt page cannot do without one

A production build emits three inline `<script>` blocks on every rendered page,
none of which this project wrote and none of which can become a file:

- the `importmap` that maps `#entry` to the hashed entry chunk,
- `@nuxtjs/color-mode`'s pre-hydration script, which has to run before first
  paint or the page flashes the wrong theme,
- `window.__NUXT__.config`, which carries `runtimeConfig.public`.

Under `script-src 'self'` all three are blocked and the page does not boot. The
nonce is what lets the policy say "these three, and nothing an injection adds".

Hashing them instead is the usual alternative and it does not work here: a hash
is fixed at build time, and `window.__NUXT__.config` changes with the
environment the server runs in.

### The one rule that is easy to get wrong

**A nonce and `'unsafe-inline'` are alternatives, never both.** Any browser that
understands a nonce ignores `'unsafe-inline'` in the same directive, so writing
both does not produce a policy with a fallback — it produces a policy that reads
strict and allows every inline script. `buildContentSecurityPolicy` picks one,
and a test asserts it never emits the pair.

## Prerendered and cached pages do not get a nonce

A nonce only works if the value in the header and the value in the HTML came from
the same render. That is true of every page this app renders on demand, and false
of every page whose HTML is **shared**: prerendered at build time, or held by an
`swr` / `isr` route rule and replayed to whoever asks next. Those bodies outlive
the request that produced them, so a fresh per-request nonce would match nothing
in the body and would block the page's own bootstrap scripts.

This is the constraint [`docs/nitro-route-rules.md`](./nitro-route-rules.md) and
[`server/utils/access-policy.ts`](../server/utils/access-policy.ts) already record
from the other direction — a response that is cached or prerendered cannot be
per-user. It cannot be per-request either, and a nonce is nothing but a
per-request value.

So shared HTML is served `script-src 'self' 'unsafe-inline'` instead. **That is a
real weakening**, and it is worth being plain about: on those pages an injected
`<script>` would run. Two things keep it contained.

First, the set is derived, not maintained. `sharedHtmlPatterns()` reads
`route-rules.config.ts` and returns the non-`/api` keys carrying `prerender`,
`swr` or `isr` — today `/rendering/isr` and `/route-rules/static`. Delete the
route rule and the page stops being an exception on the next boot; there is no
second list to forget.

Second, the build fails if a route slips out the side door.
`definePageMeta({ prerender: true })` prerenders a page without touching
`route-rules.config.ts`, and the server has no way to read a page's meta. That
mismatch would not show up as a failing test — it would show up as a blank page
in production. So the `render:html` hook throws during prerendering when it finds
a nonce on the event, which can only happen for a route the request hook thought
was dynamic:

```
/rendering/ssg is being prerendered but is not covered by a prerender/swr/isr
rule in route-rules.config.ts, so the security-headers request hook will serve
it a per-request CSP nonce that its frozen HTML cannot match.
```

The fix is to add the route rule, which is where prerendering belongs in this
project anyway — see `docs/nitro-route-rules.md`.

Cached **API** routes are not affected and keep the ordinary policy: a JSON
response has no inline script to authorise, so a stale nonce in its cached
headers means nothing to it.

## Why a Nitro plugin and not `server/middleware/`

[`docs/server-middleware.md`](./server-middleware.md) is where request-scoped work
lives in this project, and it is the wrong home for this one. Nitro serves
`public/` and every prerendered page from a handler matched **before** the
middleware chain, so a header set in `server/middleware/` never reaches them.
`/route-rules/static` is a full HTML document, prerendered by a route rule, and
it would have answered every visitor with no CSP, no HSTS and no `nosniff` —
static output being exactly the traffic that gets served for months without
anyone looking at it.

h3 calls the `request` hook at the top of the app handler, before the stack is
walked. It sees the static asset, the prerendered page, the 404 and every
rendered route alike, and it still runs before `server/middleware/10.auth.ts`, so
the 401 that file throws is already carrying these headers.

Verify it the way the claim is made:

```sh
pnpm build
NUXT_SESSION_PASSWORD=… node .output/server/index.mjs
curl -sI localhost:3000/_nuxt/entry.<hash>.css | grep -i content-security-policy
curl -sI localhost:3000/route-rules/static  | grep -i script-src   # 'unsafe-inline'
```

## Development is not where this gets signed off

`pnpm dev` runs a weaker policy, in two places and for two different reasons:

- `script-src` gains `'unsafe-eval'`, because Vite's dev transform compiles
  modules through `new Function`. The nonce is still there and still enforced.
- `style-src` drops to `'unsafe-inline'` and loses the nonce entirely, because
  Vite injects dev styles by creating `<style>` elements from JavaScript, after
  the document was parsed, where there is nothing to attach a nonce to.

Neither relaxation exists in a build. Sign the policy off against `pnpm build`
and `node .output/server/index.mjs`, never against the dev server.

## Configuration

Everything is under `runtimeConfig.security` and overridable per deployment.

| Env var                                 | Default    | Meaning                                                     |
| --------------------------------------- | ---------- | ----------------------------------------------------------- |
| `NUXT_SECURITY_CSP_MODE`                | `enforce`  | `enforce`, `report-only`, or `off`                          |
| `NUXT_SECURITY_CSP_REPORT_URI`          | —          | Same-origin path or absolute http(s) URL                    |
| `NUXT_SECURITY_CSP_CONNECT_SRC`         | —          | Extra `connect-src` origins, comma-separated                |
| `NUXT_SECURITY_CSP_IMG_SRC`             | —          | Extra `img-src` origins                                     |
| `NUXT_SECURITY_CSP_FRAME_ANCESTORS`     | `'none'`   | Who may frame this app                                      |
| `NUXT_SECURITY_HSTS_MAX_AGE_SECONDS`    | `31536000` | Clamped to 0…2 years                                        |
| `NUXT_SECURITY_HSTS_INCLUDE_SUBDOMAINS` | `true`     |                                                             |
| `NUXT_SECURITY_HSTS_PRELOAD`            | `false`    | Dropped unless subdomains are included and max-age ≥ 1 year |

`report-only` is how a policy change is rolled out: the browser reports what
_would_ have been blocked and blocks nothing, so a directive that is one origin
short shows up in the reports instead of in a support ticket. Point
`NUXT_SECURITY_CSP_REPORT_URI` at a collector, watch, then switch back to
`enforce`.

**HSTS `max-age=0` is not "off".** A browser that has seen the header keeps
honouring it for the whole `max-age` it was given, so the documented way back off
HTTPS-only is to serve `max-age=0` until that memory expires. Removing the header
instead leaves every previous visitor pinned with no way to tell them otherwise —
which is why zero is a value this config keeps rather than treats as absent, and
why `preload` is off by default. Submitting a domain to the preload list is close
to irreversible and is not a decision a boilerplate should make for its consumer.

### Configured origins are validated, not escaped

`NUXT_SECURITY_CSP_IMG_SRC='https://cdn.example.com; script-src *'` is a
response-header injection with a friendly name. `parseSourceList` accepts only
schemes, hosts, ports, paths and wildcards, and drops anything else — including
quoted keywords. Every keyword this policy uses is decided in
`server/utils/security-headers.ts`, where adding one is a code review rather than
an environment variable.

## Adding a third-party origin

Load images from a CDN, or call an API on another host, and the policy will block
it. Both are configuration, not code:

```sh
NUXT_SECURITY_CSP_IMG_SRC=https://cdn.example.com
NUXT_SECURITY_CSP_CONNECT_SRC=https://api.example.com,wss://live.example.com
```

The same-origin WebSocket in `server/api/ws/echo.ts` needs nothing: CSP 3 matches
`ws:` and `wss:` against a `http:`/`https:` origin, so `'self'` already covers it.

A third-party **script** is a different question and deliberately harder. There is
no config for it, because the answer is either to give that script the request's
nonce through `useHead({ script: [{ src, nonce }] })` with the nonce read from
`useRequestEvent()?.context.cspNonce`, or to decide that an origin allowed to
execute arbitrary code in this app is worth a commit.

## Inline `style` attributes

`style-src-attr 'unsafe-inline'` is in the policy on purpose. Vue writes `:style`
bindings out as `style` attributes, which `style-src` would otherwise block and
which no nonce can cover — an attribute has nowhere to put one. `style-src-attr`
is the directive that exists for exactly this split, and an attacker who can
already set an attribute on an element has a far better primitive available than
CSS.
