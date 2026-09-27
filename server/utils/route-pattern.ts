/**
 * Path-pattern matching for the server-side policy tables.
 *
 * Two tables under `server/utils/` decide something per request by looking at
 * its path: `access-policy.ts` (does this need a session?) and
 * `rate-limit-policy.ts` (how often may one caller ask?). Both want the same
 * matching semantics, and those semantics are a security boundary in both cases
 * — a table whose most-specific rule does not win is a table whose carve-outs
 * silently do nothing. So the matcher lives here once rather than in each table.
 *
 * ## The semantics
 *
 * A key is either an exact path (`/api/metrics`) or a prefix ending in `/**`
 * (`/api/auth/**`), which matches the prefix itself and everything below it.
 * `/**` on its own is the catch-all. The most specific key wins: longest matched
 * literal prefix, and on a tie an exact key beats a wildcard — so
 * `/api/cached/invalidate` can be carved out of `/api/cached/**` without
 * reordering the table.
 *
 * That mirrors the rou3 semantics Nitro applies to `routeRules`, which is the
 * point: a reader who knows how `route-rules.config.ts` resolves already knows
 * how these tables resolve.
 *
 * ## What this does not do
 *
 * It does not normalise the path. Every caller must match against
 * `normalisePathname(event.path)` and never `event.path` itself — see
 * `server/utils/request-path.ts` for why the difference is a bypass rather than
 * a tidiness question. Keeping normalisation out of here means there is one
 * place that does it and no ambiguity about whether a given call site already
 * has.
 *
 * It also has no notion of a parameter segment (`/api/todos/:id`). Neither table
 * needs one — a prefix already covers every route below it — and adding one
 * would mean deciding how a parameter ranks against a literal, which is exactly
 * the kind of subtlety a security table should not have.
 */

/** A compiled key: the literal prefix to match, and whether it is exact. */
export interface RoutePattern {
  /** The literal prefix. `''` for the `/**` catch-all, which matches anything. */
  readonly prefix: string
  /** `true` for an exact-path key, `false` for a `/**` wildcard. */
  readonly exact: boolean
}

/** One table entry that matched, with the key it came from. */
export interface RouteTableMatch<T> {
  /**
   * The table key that won, verbatim.
   *
   * Returned rather than discarded because a caller may need to name the rule
   * and not just read its value: `rate-limit-policy.ts` uses it as the bucket
   * scope, so two route groups with the same numeric limit still count
   * separately, and a limit that changes does not silently merge two buckets.
   */
  readonly pattern: string
  readonly value: T
}

/** Splits a table key into the prefix to match and whether it is exact. */
export function compileRoutePattern(pattern: string): RoutePattern {
  if (pattern.endsWith('/**')) {
    // `/**` compiles to an empty prefix, which matches anything.
    return { prefix: pattern.slice(0, -3), exact: false }
  }
  return { prefix: pattern, exact: true }
}

/**
 * Whether an already-normalised pathname matches a compiled key.
 *
 * A wildcard matches its own prefix as well as everything under it, so
 * `/api/auth/**` covers `/api/auth`. The `/`-terminated `startsWith` is what
 * stops `/api/auth/**` from also matching `/api/authorise`.
 */
export function routePatternMatches(pattern: RoutePattern, pathname: string): boolean {
  if (pattern.exact) return pathname === pattern.prefix
  if (pattern.prefix === '') return true
  return pathname === pattern.prefix || pathname.startsWith(`${pattern.prefix}/`)
}

/**
 * How specific a key is. Longer literal prefixes win; on a tie an exact key
 * beats a wildcard.
 *
 * Doubling the length leaves the low bit free for the exact/wildcard tiebreak,
 * so the whole ordering is one integer comparison and cannot disagree with
 * itself the way a two-field comparison can when only one field is updated.
 */
export function routePatternSpecificity(pattern: RoutePattern): number {
  return pattern.prefix.length * 2 + (pattern.exact ? 1 : 0)
}

/**
 * Resolves the most specific entry of `table` matching `pathname`, or
 * `undefined` when nothing matches.
 *
 * `pathname` must already be normalised — see the module note.
 *
 * Iteration order is irrelevant by construction: every matching key is scored
 * and the highest wins, so a table can be written in whatever order reads best
 * rather than in the order it has to be evaluated.
 */
export function matchRouteTable<T>(
  pathname: string,
  table: Readonly<Record<string, T>>,
): RouteTableMatch<T> | undefined {
  let bestPattern: RoutePattern | undefined
  let best: RouteTableMatch<T> | undefined

  for (const [pattern, value] of Object.entries(table)) {
    const compiled = compileRoutePattern(pattern)
    if (!routePatternMatches(compiled, pathname)) continue
    if (
      bestPattern === undefined ||
      routePatternSpecificity(compiled) > routePatternSpecificity(bestPattern)
    ) {
      bestPattern = compiled
      best = { pattern, value }
    }
  }

  return best
}
