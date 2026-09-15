import { extractPlainText, renderContentMarkup } from '~/server/utils/content-markup'

/**
 * The content behind the island demo — a small, static, server-owned corpus.
 *
 * Content sections are the case server islands were built for: text that is the
 * same for every visitor, changes when someone edits it rather than when someone
 * clicks something, and has no behaviour to hydrate. Everything below is a plain
 * frozen array, which is exactly how a real content section starts before it
 * becomes a CMS query — and the shape of the module does not change when it
 * does, because the island already fetches this through an API route rather than
 * importing it.
 *
 * The sections document server islands, so the demo page renders its own
 * explanation through the mechanism it is explaining.
 */

/** A section as it is authored: body in the subset `content-markup.ts` renders. */
export interface ContentSection {
  readonly slug: string
  readonly title: string
  readonly summary: string
  /** ISO date, no time — content changes on a day, not at an instant. */
  readonly updatedAt: string
  readonly body: string
}

/** A section as it is listed: everything but the body. */
export type ContentSectionSummary = Omit<ContentSection, 'body'>

/** A section as it is served: body rendered to HTML, plus a plain-text form. */
export interface RenderedContentSection extends ContentSectionSummary {
  /** HTML from {@link renderContentMarkup}. Escaped at the source. */
  readonly html: string
  /** The body as plain text, for `<meta name="description">` and search. */
  readonly plainText: string
}

export const CONTENT_SECTIONS: readonly ContentSection[] = Object.freeze([
  {
    slug: 'what-an-island-is',
    title: 'What a server island is',
    updatedAt: '2026-09-15',
    summary: 'A component that renders on the server and ships no JavaScript to render itself.',
    body: `A **server island** is a component Nuxt renders on the server and sends to the
browser as HTML. Its code is compiled into the server bundle and into no client
chunk, so a visitor downloads the markup it produced and never the component
that produced it.

That makes islands a payload decision rather than a rendering one. Ordinary SSR
already sends HTML first; what it also sends is the JavaScript to build that
same HTML again during hydration. For a section of prose, the second copy buys
nothing — there is no state to attach, no handler to bind, nothing for Vue to
take over.

### How Nuxt finds them

Two conventions, both requiring \`experimental.componentIslands\`:

- a component in \`components/islands/\`, rendered by name with \`<NuxtIsland>\`
- a component named \`Foo.server.vue\` with no \`Foo.client.vue\` beside it

The island's HTML arrives over a JSON endpoint keyed by the component name and a
hash of its props:

\`\`\`
GET /__nuxt_island/ContentSection_<hash>.json?props={"slug":"what-an-island-is"}
\`\`\`

During SSR the page fetches that endpoint internally and inlines the result, so
a first load is one document with the content already in it.`,
  },
  {
    slug: 'when-to-reach-for-one',
    title: 'When to reach for one',
    updatedAt: '2026-09-15',
    summary:
      'Static, expensive-to-render, non-interactive. Miss any of the three and use a component.',
    body: `An island earns its place when all three hold:

- the output is the **same for every visitor**, or varies over a small set of props
- rendering it costs something worth not shipping — a markup renderer, a syntax
  highlighter, a date formatter with a locale table
- nothing in it is **interactive**

Miss the third and an island is the wrong tool, not a slower one: an island's
HTML is inert. There is no Vue instance behind it, so a \`@click\` inside one is
markup that does nothing, and a \`ref\` never updates. This is the failure mode
worth knowing about, because it does not announce itself — the page renders, it
just quietly stops responding.

### What stays on the page

Interactivity lives in the component that *contains* the island. The selector on
this page is ordinary page code; changing it changes the island's props, and
Nuxt refetches the island's HTML. The split is the point: the control is a few
bytes of behaviour, the content is markup.

An island can still receive interactive markup from its parent through a slot —
the slot's content is rendered by the page, not by the island, and teleported
into place after hydration.`,
  },
  {
    slug: 'props-are-a-cache-key',
    title: 'Props are a cache key',
    updatedAt: '2026-09-15',
    summary: 'Island props travel in the URL, so they are public, logged, and cacheable.',
    body: `Island props are JSON-serialised into the island's request URL. Three
consequences follow, and all three are easy to discover the hard way:

- **They are not private.** A URL reaches access logs, proxies and CDN cache
  keys. Nothing that would not survive being written to a log belongs in an
  island prop — no token, no session id, no email address.
- **They are a cache key.** One URL per distinct props value. Props drawn from a
  small closed set cache beautifully; props carrying a timestamp or a search
  string produce an entry per request and cache nothing.
- **JSON decides what arrives.** \`undefined\`, a function and a \`Symbol\` are
  dropped outright; \`NaN\` and \`Infinity\` arrive as \`null\`. The island renders
  against props that differ from the ones the page passed, with no error
  anywhere.

\`utils/islandProps.ts\` turns all three into a check — \`inspectIslandProps()\`
reports them, and the panel at the bottom of this page runs it live against the
props being sent.

### Data, not props

The rule of thumb that follows: pass an **identifier**, not a payload. This page
sends \`{ slug }\` and the island fetches its own content. Sending the rendered
section as a prop would put the whole body in the URL, defeat the cache, and
ship the content twice.`,
  },
])

const BY_SLUG: ReadonlyMap<string, ContentSection> = new Map(
  CONTENT_SECTIONS.map((section) => [section.slug, section]),
)

/** Every section, summarised, in authored order. */
export function listContentSections(): ContentSectionSummary[] {
  return CONTENT_SECTIONS.map(({ slug, title, summary, updatedAt }) => ({
    slug,
    title,
    summary,
    updatedAt,
  }))
}

/** One section, or `undefined` when the slug does not name one. */
export function findContentSection(slug: string): ContentSection | undefined {
  return BY_SLUG.get(slug)
}

/**
 * Renders a section for delivery.
 *
 * Rendering happens per request rather than once at module load: a section is
 * cheap to render, and caching it here would be a second cache in front of the
 * one the deployment already has in front of the island endpoint. See
 * `docs/server-islands.md` for that layer.
 */
export function renderContentSection(section: ContentSection): RenderedContentSection {
  return {
    slug: section.slug,
    title: section.title,
    summary: section.summary,
    updatedAt: section.updatedAt,
    html: renderContentMarkup(section.body),
    plainText: extractPlainText(section.body),
  }
}
