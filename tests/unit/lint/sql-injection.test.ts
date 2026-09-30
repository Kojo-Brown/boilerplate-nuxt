import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'

import { describe, it, expect } from 'vitest'

/**
 * "Drizzle for all DB access; no raw SQL in route handlers" — enforced against
 * `server/`, instead of being a line in CLAUDE.md that reads the same whether it
 * is still true or not.
 *
 * Every other injection defence in this repository has a unit test behind it:
 * the Markdown renderer escapes (`content-markup`), request bodies are parsed by
 * closed schemas (`*-schemas`), the correlation id is whitelisted (`request-id`),
 * store keys encode their parts (`rate-limit-policy`, `idempotency`). SQL
 * injection — the one everybody means by "injection" — had none, because there
 * is no unit to test: the defence is the *absence* of a pattern, and absence is
 * what a scan is for. `owasp.config.ts` files this under A03 and cites the
 * tests below by name.
 *
 * ## Why the query builder is not the whole answer
 *
 * Drizzle's builder is safe by construction, and so is its `sql` tagged
 * template: an interpolated value becomes a bind parameter, not text, so
 * `sql`where id = ${untrusted}`` is parameterised however hostile the value is.
 * That is exactly why this test does not try to police which values reach a
 * template.
 *
 * What it polices is the three ways out of that guarantee:
 *
 *  - **`sql.raw()` and `sql.identifier()`** splice their argument into the
 *    statement as text. `sql.raw` is the documented escape hatch and the one an
 *    ORM's users reach for when a query resists the builder.
 *  - **`postgres.js`'s `unsafe()`**, and its client used as a tag anywhere but
 *    the module that owns it, do the same thing one layer lower.
 *  - **A statement assembled as a string**, then handed to any of the above.
 *
 * ## What it can and cannot catch
 *
 * It is a source scan over `server/`, so it sees the literal forms someone
 * writes and not a statement composed at runtime from values a scan cannot
 * follow. It is a guard rail on the obvious mistake, not a proof — the same
 * standing as `tests/unit/lint/token-storage.test.ts`, and the same reason for
 * having it: the mistake it catches is the one that actually gets made, by
 * someone in a hurry with a query the builder would not express.
 *
 * Comment bodies are blanked before any rule runs, because this codebase
 * discusses SQL at length in prose and a scan that reports its own
 * documentation gets muted rather than fixed.
 */

/** Everything Nitro compiles into the server bundle. */
const SERVER_ROOT = 'server'

const projectRoot = path.resolve(import.meta.dirname, '../../..')

async function serverSources(): Promise<string[]> {
  const found: string[] = []

  async function walk(relative: string): Promise<void> {
    const entries = await readdir(path.join(projectRoot, relative), { withFileTypes: true })

    for (const entry of entries) {
      const child = `${relative}/${entry.name}`
      if (entry.isDirectory()) await walk(child)
      else if (entry.name.endsWith('.ts')) found.push(child)
    }
  }

  await walk(SERVER_ROOT)
  return found.sort()
}

/**
 * Replaces every comment body with spaces, keeping line numbering intact so a
 * hit still names the line it is on.
 *
 * The replacement does not parse string literals, so a `//` inside one blanks
 * the rest of that line — in practice a URL in an error message. That can only
 * ever hide a violation sharing a line with such a literal, which is a narrower
 * failure than reporting every paragraph that says the word "select".
 */
function blankComments(source: string): string {
  return source.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, ' '))
}

/** APIs that put their argument into the statement as text rather than as a bind parameter. */
const RAW_SQL_APIS = /\bsql\s*\.\s*(raw|identifier)\s*\(|\.\s*unsafe\s*\(/g

/** A tagged `sql` template. These are all single-line here; a nested back-tick would end the match early. */
const SQL_TEMPLATE = /\bsql`([^`]*)`/g

/** Any string or template literal, for the assembled-statement rule. */
const ANY_LITERAL = /`[^`]*`|'[^']*'|"[^"]*"/g

/**
 * Shapes that only a SQL statement has. Deliberately two-token: a single
 * keyword matches ordinary prose in an error message ("failed to update todo"),
 * and a rule that fires on those is a rule someone deletes.
 */
const STATEMENT_SHAPE =
  /\bselect\b[\s\S]*\bfrom\b|\binsert\s+into\b|\bdelete\s+from\b|\bupdate\b[\s\S]*\bset\b|\bdrop\s+table\b/i

/** Constructing a postgres.js client. Exactly one module is allowed to. */
const CLIENT_CONSTRUCTION = /\bpostgres\s*\(/g

const sources = await serverSources()
const code = new Map<string, string>(
  await Promise.all(
    sources.map(
      async (file) =>
        [file, blankComments(await readFile(path.join(projectRoot, file), 'utf8'))] as const,
    ),
  ),
)

/** Every match of `pattern` across the scanned sources, located. */
function hits(pattern: RegExp): string[] {
  const found: string[] = []

  for (const [file, source] of code) {
    for (const match of source.matchAll(pattern)) {
      const line = source.slice(0, match.index).split('\n').length
      found.push(`${file}:${line} ${match[0].trim()}`)
    }
  }

  return found.sort()
}

describe('raw SQL in the server bundle', () => {
  it('finds the server sources it is supposed to be scanning', () => {
    // A scan that silently covers nothing passes forever. This is the canary:
    // if `server/` is restructured, this fails before the rules below start
    // reporting a clean bill of health for an empty set.
    expect(sources.length).toBeGreaterThan(50)
    expect(sources).toContain('server/utils/db.ts')
    expect(sources).toContain('server/utils/todo-store.ts')
    expect(sources).toContain('server/utils/outbox-store.ts')
    expect(sources).toContain('server/db/schema.ts')
  })

  it('calls none of the APIs that hand raw SQL to the driver', () => {
    expect(
      hits(RAW_SQL_APIS),
      'sql.raw(), sql.identifier() and postgres.js unsafe() splice text into the statement. ' +
        'Express the query with the builder, or with a sql`` template whose interpolations are ' +
        'values — those are bound, not inlined. See docs/owasp-top-10.md (A03).',
    ).toEqual([])
  })

  it('interpolates values into a tagged sql template, never assembled SQL text', () => {
    // A value in a `sql` template is a bind parameter whatever it holds, so the
    // rule is not about which values reach one. It is about interpolations that
    // carry *text*: a quote or a `+` inside `${…}` means a fragment of the
    // statement was built in JavaScript, which is the one thing the tag cannot
    // parameterise.
    const offenders: string[] = []

    for (const [file, source] of code) {
      for (const template of source.matchAll(SQL_TEMPLATE)) {
        const line = source.slice(0, template.index).split('\n').length

        for (const interpolation of (template[1] ?? '').matchAll(/\$\{([^}]*)\}/g)) {
          const expression = (interpolation[1] ?? '').trim()
          if (/['"`+]/.test(expression)) offenders.push(`${file}:${line} \${${expression}}`)
        }
      }
    }

    expect(offenders).toEqual([])
  })

  it('builds no query by concatenation or interpolation into a string', () => {
    expect(
      hits(ANY_LITERAL).filter((hit) => STATEMENT_SHAPE.test(hit)),
      'A statement that exists as a string has already left the parameterised path, whether or ' +
        'not it is interpolated today. Use the Drizzle builder.',
    ).toEqual([])
  })

  it('opens exactly one database client, in the module that owns it', () => {
    // `server/utils/db.ts` memoises a single client and is the only module that
    // may construct one; a second would be a connection pool nobody configured
    // and, more to the point here, a `postgres` tag reachable from a handler.
    expect(hits(CLIENT_CONSTRUCTION).map((hit) => hit.split(':')[0])).toEqual([
      'server/utils/db.ts',
    ])
  })
})
