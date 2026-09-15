/**
 * The markup renderer for content sections — the code that never ships.
 *
 * A server island exists to keep work on the server. This module is the work:
 * turning a section's authored source into HTML costs a parse, an escape pass
 * and a handful of regular expressions, and none of it is interactive. Rendered
 * in a normal component it would be compiled into a client chunk and downloaded
 * by every visitor so the browser could reproduce markup the server had already
 * produced. Rendered in an island it stays here, and the browser receives the
 * `<p>` tags and nothing else. That asymmetry is the whole argument for islands,
 * and it is why this renderer lives under `server/` rather than in `utils/`:
 * app-level `utils/` is auto-imported into the client bundle, so putting it
 * there would quietly undo the thing the island is for.
 *
 * ## The subset
 *
 * Deliberately small, because a boilerplate that ships a markdown engine has
 * chosen a markdown engine for its users. Blocks are separated by blank lines:
 *
 * | Source                  | Output                     |
 * | ----------------------- | -------------------------- |
 * | `### Heading`           | `<h3>`                     |
 * | `- item` (consecutive)  | `<ul><li>`                 |
 * | ` ``` ` fenced block    | `<pre><code>`              |
 * | anything else           | `<p>`, lines joined by a space |
 *
 * Inline, outside code spans: `` `code` ``, `**bold**`, and `[label](url)`.
 *
 * ## Escaping, and why the order matters
 *
 * Every character of source is HTML-escaped **before** any inline pattern is
 * applied, so the patterns only ever run over text that can no longer close a
 * tag. This is the safe order and not the obvious one: escaping afterwards would
 * escape the `<p>` this module just emitted, and escaping selectively — "only
 * the parts that aren't markup" — is how injection bugs are written.
 *
 * Escaping cannot break the patterns, because none of `& < > " '` appears in
 * them. The same fact makes the link-scheme check below sound on escaped text.
 *
 * The content here is authored in the repository, so this is defence in depth
 * rather than a boundary against a hostile author — but the output is handed to
 * `v-html` in `components/islands/ContentSection.vue`, and the day the source of
 * a section becomes a database row is the day that stops being a distinction.
 * `tests/unit/server/content-markup.test.ts` pins the escaping.
 *
 * The escaper itself is `escapeHtml` from `server/utils/stream.ts`, which the
 * streamed-HTML shell already needed for the same reason. One escaper rather
 * than two: the streaming module is an odd place to import it from, and two
 * copies of a security-relevant function that drift apart is a worse problem
 * than an awkward import.
 */
import { escapeHtml } from '~/server/utils/stream'

/** Schemes a `[label](url)` may produce. Anything else renders as plain text. */
const ALLOWED_LINK_PREFIXES = ['https://', 'http://', 'mailto:', '/', '#'] as const

const CODE_SPAN_RE = /`([^`]+)`/g
const LINK_RE = /\[([^\]]+)\]\(([^)\s]+)\)/g
const BOLD_RE = /\*\*([^*]+)\*\*/g
const FENCE_RE = /^```/
const LIST_ITEM_RE = /^- +(.*)$/
const HEADING_RE = /^### +(.*)$/

/**
 * True when an already-escaped URL starts with a scheme we are willing to emit.
 *
 * Checking the escaped form is safe because every allowed prefix is free of the
 * escaped characters, so escaping is the identity on them: a URL that would have
 * passed raw passes here, and one that would have failed still fails. A
 * `javascript:` URL fails, and so does anything trying to smuggle a scheme past
 * the check with an entity — escaping has already turned its `&` into `&amp;`,
 * which no browser resolves back into a scheme.
 */
function isAllowedLink(escapedUrl: string): boolean {
  return ALLOWED_LINK_PREFIXES.some((prefix) => escapedUrl.startsWith(prefix))
}

/**
 * Applies the inline patterns to one already-escaped run of text.
 *
 * Code spans are resolved first and their contents are left alone, so
 * `` `**not bold**` `` renders as literal asterisks inside a `<code>` — the
 * behaviour anyone writing documentation expects, and the reason this is not a
 * single chain of `.replace()` calls.
 */
function renderInline(escaped: string): string {
  const out: string[] = []
  let cursor = 0

  CODE_SPAN_RE.lastIndex = 0
  for (const match of escaped.matchAll(CODE_SPAN_RE)) {
    const start = match.index
    out.push(renderInlineOutsideCode(escaped.slice(cursor, start)))
    out.push(`<code>${match[1]}</code>`)
    cursor = start + match[0].length
  }

  out.push(renderInlineOutsideCode(escaped.slice(cursor)))
  return out.join('')
}

function renderInlineOutsideCode(escaped: string): string {
  return escaped
    .replace(LINK_RE, (full, label: string, url: string) =>
      isAllowedLink(url) ? `<a href="${url}">${label}</a>` : full,
    )
    .replace(BOLD_RE, (_full, text: string) => `<strong>${text}</strong>`)
}

interface Block {
  readonly kind: 'heading' | 'list' | 'code' | 'paragraph'
  readonly lines: string[]
}

/**
 * Groups raw source lines into blocks. Blank lines end a block; a fenced code
 * block swallows blank lines and every marker inside it, so an example of this
 * very syntax can be written in a section without being interpreted.
 *
 * An unterminated fence closes at end of input rather than throwing: a missing
 * back-tick is a typo in prose, and failing a page render over it would be a
 * worse outcome than rendering the rest of the block as code.
 */
function toBlocks(source: string): Block[] {
  const blocks: Block[] = []
  const lines = source.replace(/\r\n?/g, '\n').split('\n')

  let index = 0
  while (index < lines.length) {
    const line = lines[index] ?? ''

    if (line.trim() === '') {
      index++
      continue
    }

    if (FENCE_RE.test(line.trim())) {
      const body: string[] = []
      index++
      while (index < lines.length && !FENCE_RE.test((lines[index] ?? '').trim())) {
        body.push(lines[index] ?? '')
        index++
      }
      // Step past the closing fence when there is one.
      index++
      blocks.push({ kind: 'code', lines: body })
      continue
    }

    const heading = HEADING_RE.exec(line)
    if (heading) {
      blocks.push({ kind: 'heading', lines: [heading[1] ?? ''] })
      index++
      continue
    }

    if (LIST_ITEM_RE.test(line)) {
      const items: string[] = []
      while (index < lines.length) {
        const item = LIST_ITEM_RE.exec(lines[index] ?? '')
        if (!item) break
        items.push(item[1] ?? '')
        index++
      }
      blocks.push({ kind: 'list', lines: items })
      continue
    }

    const paragraph: string[] = []
    while (index < lines.length) {
      const current = lines[index] ?? ''
      if (current.trim() === '' || FENCE_RE.test(current.trim()) || LIST_ITEM_RE.test(current))
        break
      if (HEADING_RE.test(current)) break
      paragraph.push(current.trim())
      index++
    }
    blocks.push({ kind: 'paragraph', lines: paragraph })
  }

  return blocks
}

/**
 * Renders a section body to HTML.
 *
 * The output is a sequence of top-level block elements with no wrapper, so the
 * caller owns the container and its styling. It is safe to pass to `v-html`
 * provided nothing downstream un-escapes it.
 */
export function renderContentMarkup(source: string): string {
  return toBlocks(source)
    .map((block) => {
      switch (block.kind) {
        case 'heading':
          return `<h3>${renderInline(escapeHtml(block.lines[0] ?? ''))}</h3>`
        case 'list': {
          const items = block.lines
            .map((item) => `<li>${renderInline(escapeHtml(item))}</li>`)
            .join('')
          return `<ul>${items}</ul>`
        }
        case 'code':
          // No inline patterns inside a code block: a sample that contains a
          // back-tick or an asterisk has to survive being displayed.
          return `<pre><code>${escapeHtml(block.lines.join('\n'))}</code></pre>`
        case 'paragraph':
          return `<p>${renderInline(escapeHtml(block.lines.join(' ')))}</p>`
      }
    })
    .join('')
}

/**
 * The same source as plain text — markers dropped, blocks joined by a space.
 *
 * This is what a `<meta name="description">` and a search index want. It is
 * derived from the source rather than from the HTML so it never depends on a
 * stripping pass over generated markup, which is the version of this function
 * that goes wrong.
 */
export function extractPlainText(source: string): string {
  return toBlocks(source)
    .filter((block) => block.kind !== 'code')
    .flatMap((block) => block.lines)
    .map((line) =>
      line
        .replace(LINK_RE, (full, label: string, url: string) => (isAllowedLink(url) ? label : full))
        .replace(BOLD_RE, (_full, text: string) => text)
        .replace(CODE_SPAN_RE, (_full, text: string) => text)
        .trim(),
    )
    .filter((line) => line !== '')
    .join(' ')
}
