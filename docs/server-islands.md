# Server islands

A **server island** is a component Nuxt renders on the server and delivers as
HTML. Its code is compiled into the server bundle and into no client chunk, so
the browser receives the markup it produced and never the component that
produced it.

That is the whole feature, and it is a payload decision rather than a rendering
one. Ordinary SSR already sends HTML first; what it _also_ sends is the
JavaScript needed to build that same HTML again during hydration. For a section
of prose there is nothing for hydration to attach — no state, no handlers — so
the second copy buys nothing and is paid by every visitor.

Live demo: [`/islands`](../pages/islands.vue), public, no session required.

## What is here

| File                                                                                | What it is                                       |
| ----------------------------------------------------------------------------------- | ------------------------------------------------ |
| [`components/islands/ContentSection.vue`](../components/islands/ContentSection.vue) | One rendered content section. Fetches by slug.   |
| [`components/islands/ContentIndex.vue`](../components/islands/ContentIndex.vue)     | The section index, rendered `lazy`.              |
| [`server/utils/content-markup.ts`](../server/utils/content-markup.ts)               | The markup renderer — the code that never ships. |
| [`server/utils/content.ts`](../server/utils/content.ts)                             | The section corpus and its rendering.            |
| [`server/api/content/`](../server/api/content/)                                     | What the islands fetch.                          |
| [`utils/islandProps.ts`](../utils/islandProps.ts)                                   | The props checker: props travel in a URL.        |

Tests: [`tests/unit/islands.test.ts`](../tests/unit/islands.test.ts) (the
contract), [`content-markup.test.ts`](../tests/unit/server/content-markup.test.ts)
(the escaping), [`content.test.ts`](../tests/unit/server/content.test.ts) (the
corpus and the routes), [`islandProps.test.ts`](../tests/unit/utils/islandProps.test.ts).

## Turning them on

```ts
// nuxt.config.ts
export default defineNuxtConfig({
  experimental: { componentIslands: true },
})
```

With the flag on, Nuxt treats two things as islands:

- every component in **`components/islands/`**, rendered by name with
  `<NuxtIsland name="ContentSection" :props="{ slug }" />`
- a component named **`Foo.server.vue`** with no `Foo.client.vue` beside it,
  rendered by tag like any other component

This project uses the first. It keeps "is this an island?" a property of where
the file lives, which is the question a reader of the directory is already
asking.

The flag is deliberately **not** `{ selectiveClient: true }`. Selective client
components let an island mark a child `nuxt-client` and ship it after all. That
is a useful escape hatch and a bad default: it turns "nothing in this directory
is in the client bundle" from a property of the directory into a per-child
question. An island that needs interactivity is a component that should not have
been an island.

## The island endpoint

An island's HTML arrives over a JSON endpoint keyed by the component name, a
hash, and the props:

```
GET /__nuxt_island/ContentSection_<hash>.json?props={"slug":"what-an-island-is"}
```

The hash binds the response to the `(name, props, context, source)` tuple it was
requested for — Nuxt exports `getIslandHash` and `serializeIslandProps` from
`nuxt/app` if you ever need to build one of these URLs yourself.

During SSR the page fetches that endpoint internally and inlines the result, so
a first load is a single document with the content already in it.

## The three constraints

**1. Island markup is inert.** There is no client-side Vue instance behind it.
A `@click` inside an island is markup that does nothing; a `ref` never updates;
`onMounted` never runs. Nothing warns about any of it — the page renders and
quietly does not respond. `tests/unit/islands.test.ts` scans every file in
`components/islands/` for event bindings and client-only lifecycle hooks, because
a source scan is the only thing that catches this before a human does.

Interactivity belongs to the component that _contains_ the island. On the demo
page the `<select>` is page code; changing it changes the island's props and Nuxt
refetches the island's HTML. A few bytes of behaviour, and the content stays
markup.

**2. An island fetches its own data.** Pass an identifier, not a payload. The
demo passes `{ slug }` and the island reads `/api/content/[slug]`; passing the
rendered section in would put the whole body in the URL (see below), defeat the
cache, and ship the content twice. A top-level `await` in an island's
`<script setup>` is fine — the island endpoint renders it inside a Suspense
boundary of its own — and `useAsyncData` would only add a payload that nothing
hydrates.

**3. A route an island reads must be the same for everyone.** An island response
is keyed by name and props and by nothing else; no cookie is part of that key. So
`/api/content/**` is `public` in
[`server/utils/access-policy.ts`](../server/utils/access-policy.ts), and the demo
page is in `PUBLIC_PATHS`. If an island's data varied by user, the first
visitor's copy is what a cache in front of it would serve to everyone else.

## `lazy` defers a navigation, not a first paint

This is the part that is easy to get backwards, and the demo was written wrong
once before a browser corrected it.

`<NuxtIsland lazy>` governs exactly one case: an island mounting **on the client
with no server-rendered markup to reuse**, which is what a client-side navigation
onto the page produces. Without `lazy`, `<NuxtIsland>` awaits its fetch inside
`setup`, so the navigation waits for the island. With it, the page appears
immediately and the `#fallback` slot holds the space until the HTML arrives.

On a **full page load** `lazy` changes nothing: the island is fetched during SSR
and inlined into the document either way. Measured on the built server:

| Navigation                           | `__nuxt_island` requests from the browser                         |
| ------------------------------------ | ----------------------------------------------------------------- |
| Full load of `/islands`              | **0** — all four islands, the `lazy` one included, inlined at SSR |
| Client-side navigation to `/islands` | **5** — one per island                                            |
| Changing the `<select>`              | **1**, and zero `.js` requests                                    |

## Props are a cache key

Island props are JSON-serialised into the island's URL. Three consequences, none
of which produces an error:

1. **They are public.** A query string reaches access logs, proxies, referrer
   headers and CDN cache keys.
2. **They are the cache key.** One URL per distinct props value. A slug caches; a
   timestamp or a search box's contents produces one entry per request.
3. **JSON decides what arrives.** `undefined`, functions and symbols are dropped
   from an object; `NaN` and `Infinity` arrive as `null`; a `Date` arrives as a
   string. The island renders against props that are not the ones the page
   passed.

`inspectIslandProps()` in [`utils/islandProps.ts`](../utils/islandProps.ts)
reports all of it — plus a soft 1 kB budget on the encoded props, since they
share a request line with everything else in the URL — and
`islandPropWarnings()` turns a report into console lines. It is a report rather
than a throw: two of the four judgements are contextual, and a boilerplate should
not throw on a rule it cannot justify. The demo page runs it live against the
props it is sending and against a props object that breaks every rule at once.

Note that _every_ prop is part of the key. `ContentSection`'s `anchored` flag
exists so the demo can render one section twice without duplicating an element
id, and the anchored and unanchored renderings are two separate island responses.

## `v-html` and the escaping order

`ContentSection` hands the rendered markup to `v-html`, the one silenced
`vue/no-v-html` in this app. What makes that safe is in
[`server/utils/content-markup.ts`](../server/utils/content-markup.ts): every
character of the source is HTML-escaped **before** any markup rule is applied, so
the rules only ever run over text that can no longer close a tag.

That ordering is the safe one and not the obvious one. Escaping afterwards would
escape the `<p>` the renderer just emitted; escaping selectively — "only the
parts that aren't markup" — is how injection bugs get written. Link targets are
checked against a scheme allowlist and anything else renders as plain text, so a
`javascript:` URL in a section body is prose.

The corpus is authored in this repository, so today this is defence in depth. It
stops being defence in depth the day a section becomes a database row.

## Verifying it yourself

Island behaviour is a property of the built server, so check it against one:

```bash
NUXT_SESSION_PASSWORD=dev-only-session-password-min-32-chars pnpm build
NUXT_SESSION_PASSWORD=dev-only-session-password-min-32-chars node .output/server/index.mjs &

# The content is in the document — no island request needed to see it
curl -s localhost:3000/islands | grep -c 'server island'

# …and none of the code that produced it is in the client bundle
grep -rl 'island-prose' .output/public/_nuxt/*.js   # no matches
grep -rl 'island-prose' .output/server/chunks       # ContentSection-*.mjs

# The island endpoint answers on its own, and 404s an unknown slug
curl -s 'localhost:3000/__nuxt_island/ContentIndex_<hash>.json' | head -c 200
```

The `<hash>` is the awkward part of that last one; the practical way to get it is
to open `/islands`, change the `<select>`, and read the URL out of the network
panel.

Measured on this app's build: `ContentSection`, `ContentIndex` and their styles
compile to ~10 kB across three `.output/server/chunks/build/*.mjs` files and to
nothing at all in `.output/public/_nuxt/`. The four islands on `/islands`
contribute 8.7 kB of HTML to a 22.8 kB document.

## Adding an island

1. Put the component in `components/islands/`. No handlers, no `v-model`, no
   client-only lifecycle hooks — `tests/unit/islands.test.ts` enforces this.
2. Give it props that are identifiers, and let it fetch what it needs.
3. If it reads an API route, decide that route's access in
   `server/utils/access-policy.ts` — an island response has no user attached.
4. Render it with `<NuxtIsland name="…" :props="…" />`. Add a `#fallback` slot:
   it is what shows when the island errors, and during a lazy client-side
   navigation.
5. Add the island to the demo page, or `tests/unit/islands.test.ts` will fail on
   an island nothing renders.
