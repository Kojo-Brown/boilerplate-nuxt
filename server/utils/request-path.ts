/**
 * Path normalisation for policy matching.
 *
 * The access policy decides whether a request needs a session by looking at its
 * path, so the path it looks at has to be the same one the router will resolve.
 * Anywhere those two disagree is a bypass: a rule that protects `/api/todos` is
 * worth nothing if `/api/route-rules/%2e%2e/todos` reaches the todos handler
 * while the policy sees a path under the public `/api/route-rules` prefix.
 *
 * `normalisePathname` closes that gap by reducing a raw request path to its
 * canonical form before any rule is matched:
 *
 *  - the query string and fragment are dropped (`/api/todos?page=2` → `/api/todos`)
 *  - percent-escapes are decoded, repeatedly, until the value stops changing —
 *    so `%2e%2e` and the double-encoded `%252e%252e` both become `..`
 *  - `.` segments are dropped and `..` segments pop their parent
 *  - repeated slashes collapse and a trailing slash is removed
 *
 * Decoding to a fixed point is deliberately more aggressive than a single pass.
 * It can only ever make the matched path *more* specific than what the router
 * resolves, which fails towards "this needs a session", never away from it.
 */

/** How many decode passes before giving up. Three is far past any real input. */
const MAX_DECODE_PASSES = 3

/**
 * `decodeURIComponent` throws on a malformed escape (`%zz`, a lone `%`). A
 * malformed path is a 404 waiting to happen, not something to crash a
 * middleware over, so the raw value is used as-is when it cannot be decoded.
 */
function decodeOnce(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/** Decodes until the value stops changing, or {@link MAX_DECODE_PASSES} is hit. */
function decodeToFixedPoint(value: string): string {
  let current = value
  for (let pass = 0; pass < MAX_DECODE_PASSES; pass++) {
    const next = decodeOnce(current)
    if (next === current) return current
    current = next
  }
  return current
}

/**
 * Reduces a raw request path to the canonical pathname the access policy
 * matches against. Always returns a value starting with `/`; the root is `/`.
 */
export function normalisePathname(rawPath: string): string {
  const withoutFragment = rawPath.split('#', 1)[0] ?? ''
  const withoutQuery = withoutFragment.split('?', 1)[0] ?? ''
  const decoded = decodeToFixedPoint(withoutQuery)

  const resolved: string[] = []
  for (const segment of decoded.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      resolved.pop()
      continue
    }
    resolved.push(segment)
  }

  return `/${resolved.join('/')}`
}
