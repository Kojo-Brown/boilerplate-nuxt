/**
 * The server-side access policy — which request paths need a session.
 *
 * This is the server counterpart to `middleware/auth.global.ts`. That one is a
 * Vue Router guard: it decides which *pages* a browser may navigate to, it runs
 * in the client bundle, and it has never applied to anything under `server/`
 * (see the note in `route-rules.config.ts`). It is a UX affordance, not a gate —
 * `curl` never runs it. This table is the gate.
 *
 * ## Default deny
 *
 * `/api/**` requires a session. Every public API route is an explicit carve-out
 * below with a reason attached, so the failure mode of adding a route and
 * forgetting about auth is a 401, not an open endpoint.
 * `tests/unit/server/access-policy.test.ts` walks `server/api/` and fails if a
 * carve-out no longer names a route that exists, so a hole cannot outlive the
 * endpoint it was opened for.
 *
 * ## The three outcomes
 *
 * - **`authenticated`** — `server/middleware/10.auth.ts` resolves the session and
 *   rejects the request with 401 when there is no user. The handler can read
 *   `event.context.auth.user` without a null check via `requireAuth(event)`.
 * - **`public`** — the session is still resolved, so a handler can personalise
 *   its response, but a request without one is served normally.
 * - **`unmanaged`** — the auth middleware does not touch the request at all and
 *   `event.context.auth` stays anonymous. This is page and asset traffic, where
 *   Nuxt's own session plugin and the route guard already do the work; unsealing
 *   the session cookie for every `.js` chunk would be pure overhead.
 *
 * ## Matching
 *
 * A key is either an exact path (`/api/metrics`) or a prefix ending in `/**`
 * (`/api/auth/**`), which matches the prefix itself and everything below it. The
 * most specific key wins — longest matched prefix, with an exact key beating a
 * wildcard of the same length. That mirrors the rou3 semantics Nitro applies to
 * `routeRules`, so the two tables can be read the same way.
 */
export type RouteAccess = 'public' | 'authenticated' | 'unmanaged'

export const serverAccessRules: Readonly<Record<string, RouteAccess>> = {
  // Pages, Nuxt payloads, build assets. Not the auth middleware's business.
  '/**': 'unmanaged',

  // Default deny for the API surface.
  '/api/**': 'authenticated',

  // Signing in cannot require being signed in.
  '/api/auth/**': 'public',

  // The OAuth callback (`server/routes/auth/github.get.ts`) is where a session
  // is created, so it is reached without one. It is listed rather than left to
  // the `/**` default because it is a server route, not a page — an explicit
  // entry is what stops it being read as an oversight.
  '/auth/**': 'public',

  // The route-rules demo endpoints are cached by Nitro (`swr`/`isr`) and read
  // cross-origin (`cors`). A cached response is shared by every caller, so it
  // must not depend on who asked for it; a CORS endpoint is by definition for
  // callers with no cookie on this origin. See docs/nitro-route-rules.md.
  '/api/route-rules/**': 'public',

  // The cached-function demo endpoints, for the same reason as the route-rules
  // ones above: a `defineCachedEventHandler` response is stored once and served
  // to every caller, so a route that is cached must not answer differently
  // depending on who asked. See docs/nitro-cached-functions.md.
  '/api/cached/**': 'public',

  // — except the one that empties those caches. It is not a read: it costs a
  // re-render of everything it touches, so leaving it open would be a
  // cache-stampede button. An exact key beats the wildcard above it.
  '/api/cached/invalidate': 'authenticated',

  // Read during the SSR of `/rendering/isr`, whose HTML is itself cached for 60
  // seconds by a route rule. The render that fills that cache happens on behalf
  // of whoever missed it first, so it has no user to forward — same reasoning as
  // the prerender note in docs/nitro-route-rules.md.
  '/api/rendering/**': 'public',
} as const

interface CompiledRule {
  /** The literal prefix a path must match. */
  readonly prefix: string
  /** Exact-path key, or a `/**` wildcard. */
  readonly exact: boolean
  readonly access: RouteAccess
}

function compile(pattern: string): CompiledRule {
  if (pattern.endsWith('/**')) {
    // `/**` (the catch-all) compiles to an empty prefix, which matches anything.
    return { prefix: pattern.slice(0, -3), exact: false, access: 'unmanaged' }
  }
  return { prefix: pattern, exact: true, access: 'unmanaged' }
}

function matches(rule: CompiledRule, pathname: string): boolean {
  if (rule.exact) return pathname === rule.prefix
  if (rule.prefix === '') return true
  return pathname === rule.prefix || pathname.startsWith(`${rule.prefix}/`)
}

/**
 * Scores a matching rule. Longer literal prefixes win; on a tie an exact key
 * beats a wildcard, so `/api/metrics` can be carved out of `/api/**` without
 * reordering the table.
 */
function specificity(rule: CompiledRule): number {
  return rule.prefix.length * 2 + (rule.exact ? 1 : 0)
}

/**
 * Resolves the access requirement for an already-normalised pathname (see
 * {@link normalisePathname}). An unmatched path is `unmanaged` — but the table
 * carries a `/**` catch-all, so that only happens if it is removed.
 */
export function resolveAccess(
  pathname: string,
  rules: Readonly<Record<string, RouteAccess>> = serverAccessRules,
): RouteAccess {
  let best: CompiledRule | undefined

  for (const [pattern, access] of Object.entries(rules)) {
    const rule = { ...compile(pattern), access }
    if (!matches(rule, pathname)) continue
    if (best === undefined || specificity(rule) > specificity(best)) {
      best = rule
    }
  }

  return best?.access ?? 'unmanaged'
}

/**
 * The keys that open a hole in the default deny, i.e. the `public` carve-outs
 * under `/api`. Exported so a test can assert each one still names a live route.
 */
export function publicApiPatterns(
  rules: Readonly<Record<string, RouteAccess>> = serverAccessRules,
): string[] {
  return Object.entries(rules)
    .filter(([pattern, access]) => access === 'public' && pattern.startsWith('/api'))
    .map(([pattern]) => pattern)
}
