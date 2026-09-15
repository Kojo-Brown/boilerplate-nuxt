/**
 * Island props are a URL. This module is what makes that visible.
 *
 * `<NuxtIsland>` serialises its `props` to JSON and hangs them off the island's
 * request URL:
 *
 * ```
 * /__nuxt_island/ContentSection_<hash>.json?props={"slug":"props-are-a-cache-key"}
 * ```
 *
 * Three properties follow from that single fact, and none of them is announced
 * by a type error:
 *
 *  1. **The props are public.** They travel in a query string, so they reach
 *     access logs, proxies, referrer headers and CDN cache keys. A session id or
 *     an email address in an island prop is a session id in a log file.
 *  2. **The props are the cache key.** One URL per distinct value. A prop drawn
 *     from a closed set (a slug, a locale) caches; a prop carrying a timestamp
 *     or a search box's contents produces a fresh entry per request and caches
 *     nothing, while still paying for the round trip.
 *  3. **JSON decides what arrives.** `undefined`, functions and symbols are
 *     dropped from an object; `NaN` and `Infinity` arrive as `null`; a `Date`
 *     arrives as a string. The island then renders against props that are not
 *     the props the page passed, and the only symptom is wrong output.
 *
 * {@link inspectIslandProps} reports all four failure modes against a props
 * object before it is handed to `<NuxtIsland>`. It is a report rather than a
 * throw because two of the four are judgement calls — a 2 kB prop is a mistake
 * in a page with a hundred islands and fine in a page with one — and a
 * boilerplate that throws on them would be teaching a rule it cannot justify.
 * `pages/islands.vue` renders the report; {@link islandPropWarnings} turns it
 * into console lines, the same arrangement `utils/payloadBudget.ts` uses.
 *
 * This is app-level rather than server-level on purpose: the props are composed
 * by the page, which is client code, so this is where the check has to run.
 * Nothing here imports the island, so it costs a few hundred bytes of client
 * bundle and no island ships because of it.
 */

/**
 * A soft ceiling for the encoded props, in bytes.
 *
 * Not a protocol limit — it is a fraction of one. Servers and proxies cap a
 * whole request line somewhere between 4 kB and 8 kB, and the props share that
 * line with the island name, the hash and the rest of the query. 1 kB leaves
 * room for all of it and is generous for the only thing that belongs in an
 * island prop: an identifier.
 */
export const ISLAND_PROPS_BUDGET_BYTES = 1024

/**
 * Key fragments that mark a value as something that must not be in a URL. Matched
 * case-insensitively against each path segment, so `user.apiKey` is caught by
 * `apikey` after the segment is lowercased.
 */
const SENSITIVE_KEY_FRAGMENTS = [
  'token',
  'secret',
  'password',
  'passwd',
  'credential',
  'authorization',
  'auth',
  'cookie',
  'session',
  'apikey',
  'api_key',
  'private',
] as const

export type IslandPropIssueKind =
  /** The value has no JSON form, so the island never receives the key. */
  | 'dropped'
  /** The value survives serialisation as something else. */
  | 'coerced'
  /** The key looks like a credential and props travel in a URL. */
  | 'sensitive'
  /** The serialised props exceed {@link ISLAND_PROPS_BUDGET_BYTES}. */
  | 'oversize'
  /** The props cannot be serialised at all — a cycle, or a `BigInt`. */
  | 'unserialisable'

export interface IslandPropIssue {
  readonly kind: IslandPropIssueKind
  /** Dotted path to the offending value, or `''` for whole-object issues. */
  readonly path: string
  /** One sentence, written to be shown to a developer as-is. */
  readonly detail: string
}

export interface IslandPropsReport {
  /** Exactly what `<NuxtIsland>` will put in the URL, or `null` if it cannot. */
  readonly serialised: string | null
  /** Byte length of the serialised props once percent-encoded for the query. */
  readonly bytes: number
  readonly budgetBytes: number
  readonly issues: readonly IslandPropIssue[]
  /** True when there is nothing to report. */
  readonly ok: boolean
}

/**
 * Serialises props the way `<NuxtIsland>` does.
 *
 * Nuxt drops `data-v-*` keys before serialising — they are scoped-style markers
 * the parent's compiler adds, not island input — and this has to drop them too,
 * or every report would flag props the island never sees. Nuxt exports the same
 * function from `nuxt/app` as `serializeIslandProps`; it is reimplemented here
 * so this module stays importable from a plain Vitest process, and
 * `tests/unit/utils/islandProps.test.ts` pins the two together by asserting the
 * documented behaviour rather than trusting the copy.
 */
export function serialiseIslandProps(props: Record<string, unknown> | undefined): string | null {
  const filtered: Record<string, unknown> = {}
  for (const key in props) {
    if (!key.startsWith('data-v-')) filtered[key] = props[key]
  }

  try {
    return JSON.stringify(filtered) ?? null
  } catch {
    // A cycle, or a BigInt. Either way there is no URL to build.
    return null
  }
}

/** Percent-encoded byte length — what the value actually costs in a query string. */
function encodedBytes(serialised: string): number {
  return new TextEncoder().encode(encodeURIComponent(serialised)).length
}

function isSensitiveKey(key: string): boolean {
  const lowered = key.toLowerCase()
  return SENSITIVE_KEY_FRAGMENTS.some((fragment) => lowered.includes(fragment))
}

function joinPath(parent: string, key: string): string {
  return parent === '' ? key : `${parent}.${key}`
}

/**
 * Walks the props depth-first, recording what serialisation will do to each
 * value. Arrays are walked too: a dropped value inside an array does not vanish
 * the way it does in an object, it becomes `null`, which is the more confusing
 * of the two outcomes and so worth naming separately.
 */
function collectValueIssues(value: unknown, path: string, issues: IslandPropIssue[]): void {
  if (typeof value === 'bigint') {
    issues.push({
      kind: 'unserialisable',
      path,
      detail: 'A BigInt cannot be serialised to JSON; send it as a string.',
    })
    return
  }

  if (typeof value === 'number' && !Number.isFinite(value)) {
    issues.push({
      kind: 'coerced',
      path,
      detail: `${String(value)} serialises to null; the island will receive null.`,
    })
    return
  }

  if (value instanceof Date) {
    issues.push({
      kind: 'coerced',
      path,
      detail: 'A Date serialises to an ISO string; the island receives a string, not a Date.',
    })
    return
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      const itemPath = `${path}[${index}]`
      if (item === undefined || typeof item === 'function' || typeof item === 'symbol') {
        issues.push({
          kind: 'coerced',
          path: itemPath,
          detail: 'An array hole serialises to null rather than disappearing.',
        })
        return
      }
      collectValueIssues(item, itemPath, issues)
    })
    return
  }

  if (value !== null && typeof value === 'object') {
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      collectKeyIssues(key, nested, path, issues)
    }
  }
}

function collectKeyIssues(
  key: string,
  value: unknown,
  parentPath: string,
  issues: IslandPropIssue[],
): void {
  const path = joinPath(parentPath, key)

  if (isSensitiveKey(key)) {
    issues.push({
      kind: 'sensitive',
      path,
      detail: 'Island props travel in a URL, where this would reach logs and cache keys.',
    })
  }

  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') {
    issues.push({
      kind: 'dropped',
      path,
      detail: 'JSON drops this, so the island renders as though the prop were never passed.',
    })
    return
  }

  collectValueIssues(value, path, issues)
}

/**
 * Inspects a props object exactly as `<NuxtIsland>` would send it.
 *
 * `data-v-*` keys are excluded from the walk for the same reason they are
 * excluded from the serialisation: they are not island input.
 */
export function inspectIslandProps(
  props: Record<string, unknown> | undefined,
  budgetBytes: number = ISLAND_PROPS_BUDGET_BYTES,
): IslandPropsReport {
  const issues: IslandPropIssue[] = []

  for (const key in props) {
    if (key.startsWith('data-v-')) continue
    collectKeyIssues(key, props[key], '', issues)
  }

  const serialised = serialiseIslandProps(props)

  if (serialised === null) {
    issues.push({
      kind: 'unserialisable',
      path: '',
      detail: 'These props have no JSON form, so no island URL can be built from them.',
    })

    return { serialised: null, bytes: 0, budgetBytes, issues, ok: false }
  }

  const bytes = encodedBytes(serialised)

  if (bytes > budgetBytes) {
    issues.push({
      kind: 'oversize',
      path: '',
      detail: `${bytes} encoded bytes of props against a ${budgetBytes}-byte budget; pass an identifier and let the island fetch the rest.`,
    })
  }

  return { serialised, bytes, budgetBytes, issues, ok: issues.length === 0 }
}

/**
 * One line per issue, ready to print. Empty when the report is clean.
 *
 * Returned rather than logged, for the reason `payloadBudgetWarning` gives: the
 * decision about *whether* to warn — development only, in this app — belongs at
 * the call site, and the text itself can then be asserted in a test instead of
 * scraped off the console. `name` is the island being rendered, so a page with
 * several of them says which one is at fault.
 */
export function islandPropWarnings(name: string, report: IslandPropsReport): string[] {
  return report.issues.map((issue) => {
    const where = issue.path === '' ? name : `${name}.${issue.path}`
    return `[island props] ${issue.kind}: ${where} — ${issue.detail}`
  })
}
