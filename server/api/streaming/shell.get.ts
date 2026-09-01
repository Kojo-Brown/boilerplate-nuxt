import {
  abortableDelay,
  escapeHtml,
  requestAbortSignal,
  sendProgressiveHtml,
} from '~/server/utils/stream'

/**
 * A progressively rendered HTML document.
 *
 * `feed.get.ts` streams *data* to a page that is already open. This one streams
 * the page: it is a plain HTTP response, opened in a tab, with no JavaScript
 * involved on either side. The shell paints while the sections are still being
 * produced, which is the behaviour every streaming-SSR framework is built on and
 * is worth seeing once without a framework in front of it.
 *
 * Three things make it work, and each of them is a way to get it wrong:
 *
 *  1. **The head is flushed before anything is fetched.** The point of the
 *     exercise. Awaiting the sections first and then writing the document is a
 *     normal response with extra steps.
 *  2. **The head is over ~1 KB.** Browsers do not begin parsing until they have
 *     a first buffer's worth — historically 1024 bytes in Chrome and Safari, and
 *     the reason a small shell "does not stream" on a fast local connection
 *     while the identical code streams in production behind a bigger document.
 *     The inline stylesheet below is what carries it past that, deliberately.
 *  3. **Tags are closed by whoever ends the response.** Including the error
 *     path — see `htmlErrorChunk` in `server/utils/stream.ts`. An HTML parser
 *     recovers from a truncated document by rendering it as if it were finished,
 *     so an unterminated stream looks exactly like a complete one.
 *
 * The `<section>` order is the order the data resolves in, because a chunk that
 * has been written cannot be moved. Out-of-order streaming — a placeholder in
 * the shell, filled from a script in a later chunk — is what React's Suspense
 * boundaries and Nuxt's `<NuxtIsland>` do on top of this, and it is a
 * different item.
 */
interface Section {
  readonly id: string
  readonly title: string
  /** How long this section's data "takes" to produce. */
  readonly delayMs: number
  readonly body: string
}

const SECTIONS: readonly Section[] = [
  {
    id: 'fast',
    title: 'Cached summary',
    delayMs: 150,
    body: 'Already in memory. It is on screen while the two below are still being produced.',
  },
  {
    id: 'medium',
    title: 'Database read',
    delayMs: 900,
    body: 'A query the page could not have been rendered without, had it been rendered all at once.',
  },
  {
    id: 'slow',
    title: 'Upstream API',
    delayMs: 1800,
    body: 'The slowest dependency. In a buffered response every byte above waits for this one.',
  },
]

export default defineEventHandler((event) => {
  const signal = requestAbortSignal(event)
  return sendProgressiveHtml(event, documentChunks(signal), { signal })
})

async function* documentChunks(signal: AbortSignal): AsyncGenerator<string> {
  const startedAt = Date.now()

  yield documentHead()

  for (const section of SECTIONS) {
    await abortableDelay(section.delayMs, signal)
    if (signal.aborted) return
    yield renderSection(section, Date.now() - startedAt)
  }

  yield documentTail(Date.now() - startedAt)
}

function documentHead(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Progressive HTML streaming</title>
<style>
  :root { color-scheme: light dark; }
  body {
    margin: 0;
    padding: 2rem 1.5rem;
    font: 16px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    max-width: 44rem;
    margin-inline: auto;
  }
  h1 { font-size: 1.5rem; margin: 0 0 0.25rem; }
  p.lede { margin: 0 0 2rem; opacity: 0.75; }
  section {
    border: 1px solid color-mix(in srgb, currentColor 20%, transparent);
    border-radius: 0.75rem;
    padding: 1rem 1.25rem;
    margin-bottom: 1rem;
  }
  section h2 { font-size: 1rem; margin: 0 0 0.5rem; }
  section p { margin: 0; }
  .elapsed, footer, .pending {
    font: 0.8125rem/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
    opacity: 0.7;
  }
  .stream-error { color: #b91c1c; font-weight: 600; }
  @media (prefers-color-scheme: dark) { .stream-error { color: #f87171; } }
</style>
</head>
<body>
<main>
<h1>Progressive HTML streaming</h1>
<p class="lede">
  This shell was written to the socket before any of the sections below existed.
  Each one appears as its data resolves.
</p>
<p class="pending">Sections appear below as the server flushes them.</p>
`
}

function renderSection(section: Section, elapsedMs: number): string {
  return `<section id="${escapeHtml(section.id)}">
<h2>${escapeHtml(section.title)}</h2>
<p>${escapeHtml(section.body)}</p>
<p class="elapsed">flushed at +${elapsedMs} ms</p>
</section>
`
}

function documentTail(elapsedMs: number): string {
  return `<footer>Document complete after ${elapsedMs} ms.</footer>
</main>
</body>
</html>
`
}
