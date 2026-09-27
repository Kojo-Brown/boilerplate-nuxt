import { matchRouteTable } from '~/server/utils/route-pattern'
import { clampPolicy, type RateLimitPolicy } from '~/server/utils/rate-limit'

/**
 * The rate-limit policy — which paths are limited, how hard, and whose quota it
 * comes out of.
 *
 * The algorithm is `server/utils/rate-limit.ts`. This file is the two questions
 * that come before it: *which bucket* and *how big*.
 *
 * ## The table
 *
 * Same shape and same matching as `server/utils/access-policy.ts` — an exact path
 * or a `/**` prefix, most specific key wins — through the shared matcher in
 * `server/utils/route-pattern.ts`. A reader who knows one table knows this one.
 *
 * `null` means "not limited", and it is the value the catch-all carries: pages,
 * Nuxt payloads and build assets are not limited here. That is not an oversight,
 * it is the same reasoning `access-policy.ts` gives for leaving them
 * `unmanaged` — a limiter on every `.js` chunk would add a storage round trip to
 * every asset a page loads, and the thing worth protecting is the API surface
 * behind them. A page flood is a volumetric problem and belongs at the edge; see
 * the note at the top of `server/utils/rate-limit.ts`.
 *
 * Unlike the access policy, this table is **not** default-deny in any meaningful
 * sense — every `/api` route gets *a* limit, and the interesting entries are the
 * ones that are deliberately tighter or looser than the default. Each of those
 * carries its reason inline, and
 * `tests/unit/server/rate-limit-policy.test.ts` walks `server/api/` and fails if
 * an exact key stops naming a route that exists, so a limit cannot outlive the
 * endpoint it was written for.
 *
 * ## Why the limits are code and not environment variables
 *
 * There is no `NUXT_RATE_LIMIT_API_LIMIT`. The numbers below are judgements about
 * what each endpoint costs and what abusing it buys, and a judgement belongs next
 * to its reason where a reviewer can disagree with it — the same argument
 * `access-policy.ts` makes for keeping its carve-outs in code. What *is*
 * configurable is the off switch and the proxy hop count, because those are
 * properties of a deployment rather than of a route.
 *
 * ## Whose quota: the identity
 *
 * A bucket is keyed by the rule that matched **plus** the caller, and the caller
 * is their user id when they have a session and their IP address when they do
 * not. Both halves matter:
 *
 *  - **User id first.** A signed-in caller behind a shared NAT — an office, a
 *    university, a mobile carrier — should not be throttled by their neighbours,
 *    and a signed-in abuser should not escape their quota by changing address.
 *  - **IP when anonymous,** because there is nothing else. This is the case that
 *    covers the limits that matter most (`/api/auth/login` has no session by
 *    definition), and it is why {@link resolveClientIp} is written as carefully
 *    as it is.
 *
 * The cost of preferring the user id, stated plainly: an attacker holding N valid
 * sessions gets N quotas. That is the right trade — accounts are the expensive
 * thing to obtain, IP addresses are not — but it means a per-account limit is a
 * fairness control, and the anti-abuse limits are the IP-keyed ones.
 */

/** A matched rule: the key it came from, and the limit it carries. */
export interface RateLimitMatch {
  /**
   * The table key, used as the bucket scope so two route groups never share a
   * counter. See `RouteTableMatch.pattern`.
   */
  readonly rule: string
  readonly policy: RateLimitPolicy
}

/**
 * Path → limit. `null` is "not limited".
 *
 * The default for the API surface is deliberately generous: it is a ceiling that
 * a person using the app cannot reach and a scraper or a runaway retry loop can,
 * which is the shape a default limit should have. The tight numbers are the
 * named endpoints below, where the cost of a request or the value of abusing it
 * is specific enough to argue about.
 */
export const rateLimitRules: Readonly<Record<string, RateLimitPolicy | null>> = {
  // Pages, Nuxt payloads, build assets. See the module note.
  '/**': null,

  // The API default — 5 requests a second, sustained. A page doing its worst on
  // load makes a handful of calls; nothing interactive approaches this.
  '/api/**': { limit: 300, windowSeconds: 60 },

  // Credential stuffing is the attack this whole feature is most worth having
  // for, and it is the one place where a limit a real person might notice is
  // still the right call: five attempts per five minutes, per IP, because an
  // unauthenticated caller has no user id to key on. A person who has genuinely
  // forgotten their password tries three or four times and then resets it; an
  // attacker working a leaked credential list needs thousands and gets 60 an
  // hour. The window is long rather than the limit small on purpose — a short
  // window with the same rate would let the list be worked in bursts.
  '/api/auth/login': { limit: 5, windowSeconds: 300 },

  // Everything else under `/api/auth` — logout, and the OAuth entry points. Well
  // above what a person generates and well below what enumerating anything
  // would need.
  '/api/auth/**': { limit: 20, windowSeconds: 60 },

  // Minting a CSRF token is one HMAC, and a client that navigates for a long
  // time legitimately asks for a fresh one — so this is loose. It is not
  // unlimited, because it is reachable without a session and a free endpoint is
  // a free endpoint. An exact key, so it beats the `/api/auth/**` entry above
  // rather than inheriting a limit that would break a long-lived tab.
  '/api/auth/csrf': { limit: 60, windowSeconds: 60 },

  // Core Web Vitals ingest. Public and unauthenticated by necessity (see
  // `access-policy.ts`), so this is an IP-keyed limit on the one write endpoint
  // anyone can reach. Loose enough for a real browser — a page load beacons each
  // metric as it settles, several requests per navigation — and far below what
  // flooding the aggregate would take.
  '/api/vitals': { limit: 120, windowSeconds: 60 },

  // Each call hands back a signed S3 URL that is valid after the response ends,
  // so this is the one endpoint where the limit bounds work the app cannot see
  // and cannot take back.
  '/api/uploads/presign': { limit: 20, windowSeconds: 60 },

  // Emptying a cache costs a re-render of everything it touches, which makes an
  // open one a cache-stampede button. It is already `authenticated`; this bounds
  // what a signed-in caller can do with it.
  '/api/cached/invalidate': { limit: 5, windowSeconds: 60 },

  // A handshake ticket is a bearer credential with a 30-second life. A client
  // needs one per socket and reconnects with backoff, so this covers a bad
  // network comfortably and not a loop.
  '/api/ws/ticket': { limit: 30, windowSeconds: 60 },
} as const

/**
 * Resolves the limit for an already-normalised pathname, or `null` when the path
 * is not limited.
 *
 * `pathname` must come from `normalisePathname(event.path)` — see
 * `server/utils/request-path.ts` for why matching a raw path is a bypass. The
 * consequence here is milder than for the access policy (the wrong bucket, not
 * an open endpoint) but it is the same mistake, so it gets the same handling.
 *
 * The policy is clamped on the way out, so a typo in the table above — a limit of
 * `0`, a negative window — cannot silently turn into no limit at all.
 */
export function resolveRateLimitPolicy(
  pathname: string,
  rules: Readonly<Record<string, RateLimitPolicy | null>> = rateLimitRules,
): RateLimitMatch | null {
  const match = matchRouteTable(pathname, rules)
  if (match === undefined || match.value === null) return null

  return { rule: match.pattern, policy: clampPolicy(match.value) }
}

/** Who a request is counted against. */
export interface RateLimitIdentity {
  readonly kind: 'user' | 'ip' | 'unknown'
  readonly value: string
}

/**
 * An address that may become part of a storage key and a log line, so it is
 * whitelisted rather than trusted: hex digits, dots and colons, which covers
 * every IPv4 and IPv6 form including the IPv4-mapped ones.
 *
 * 45 characters is the longest possible textual IPv6 address (an IPv4-mapped
 * address with a zone id is longer, and a zone id is meaningless off the host
 * that produced it). The same reasoning as `isSafeIdempotencyKey` and
 * `isSafeRequestId`: anything reaching a key or a log stream from outside is
 * checked against a list of what is allowed, not scrubbed of what is not.
 */
const SAFE_ADDRESS = /^[0-9a-f.:]{3,45}$/i

/**
 * Normalises an address so the same host always lands in the same bucket.
 *
 * Two forms have to be reconciled. Node reports a peer on a dual-stack socket as
 * an IPv4-mapped IPv6 address (`::ffff:127.0.0.1`) while a proxy writes the plain
 * IPv4 form, and an `x-forwarded-for` entry may carry a port, bracketed for IPv6
 * (`[2001:db8::1]:443`). Left alone, one client would occupy two buckets
 * depending on which path the value came down.
 */
export function normaliseAddress(value: string): string {
  let address = value.trim().toLowerCase()

  // `[::1]:443` → `::1`. Only the bracketed form can be split safely: an
  // unbracketed IPv6 address is full of colons, so there is no way to tell a
  // trailing port from a final group.
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(address)
  if (bracketed?.[1] !== undefined) {
    address = bracketed[1]
  } else if (/^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(address)) {
    // `1.2.3.4:443` → `1.2.3.4`. Unambiguous, because an IPv4 address has no
    // colons of its own.
    address = address.slice(0, address.lastIndexOf(':'))
  }

  // `::ffff:127.0.0.1` → `127.0.0.1`.
  return address.startsWith('::ffff:') ? address.slice(7) : address
}

export interface ClientIpInput {
  /** The raw `x-forwarded-for` header, if any. */
  readonly forwardedFor: string | undefined
  /** `event.node.req.socket.remoteAddress` — the one value a caller cannot set. */
  readonly socketAddress: string | undefined
  /** From {@link RateLimitSettings}; see the long note in `rate-limit.ts`. */
  readonly trustProxyHops: number
}

/**
 * The caller's address, counting trusted hops from the **right** of
 * `x-forwarded-for`.
 *
 * The long explanation of why it is from the right — and why h3's
 * `getRequestIP(event, { xForwardedFor: true })` is not usable here — is in
 * `resolveRateLimitSettings`. The short version: proxies append, so the leftmost
 * entry is whatever the client claimed and the rightmost entries are the ones
 * infrastructure you control wrote. With `trustProxyHops: 1`, a client that sends
 * `x-forwarded-for: 9.9.9.9` in the hope of a fresh bucket produces
 * `9.9.9.9, <their real ip>` at the balancer, and this reads the second.
 *
 * Falls back to the socket address whenever the header cannot be used: absent,
 * shorter than the configured hop count, or an entry that is not address-shaped.
 * A chain shorter than expected means either a misconfigured hop count or a
 * request that reached the app without passing the proxy, and in both cases the
 * socket is the only value that is certainly true.
 *
 * Returns `null` when there is nothing usable at all — see
 * {@link rateLimitIdentity} for what that becomes.
 */
export function resolveClientIp(input: ClientIpInput): string | null {
  const socket = usableAddress(input.socketAddress)

  if (input.trustProxyHops <= 0) return socket

  const chain = (input.forwardedFor ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')

  // Count from the right: the last entry was written by the nearest proxy.
  const forwarded = usableAddress(chain[chain.length - input.trustProxyHops])

  return forwarded ?? socket
}

/** An address that passed {@link SAFE_ADDRESS}, normalised, or `null`. */
function usableAddress(value: string | undefined): string | null {
  if (value === undefined) return null
  const normalised = normaliseAddress(value)
  return SAFE_ADDRESS.test(normalised) ? normalised : null
}

export interface IdentityInput {
  /** The authenticated user's id, or `null` for an anonymous request. */
  readonly userId: string | null
  /** From {@link resolveClientIp}. */
  readonly clientIp: string | null
}

/**
 * Who this request is counted against — the user when there is one, otherwise the
 * address.
 *
 * ## The `unknown` bucket
 *
 * With neither a user nor a usable address, every such request shares one bucket.
 * That is a deliberate choice between two bad options: a shared bucket throttles
 * unrelated callers together, and skipping the limit means an endpoint with no
 * limit at all for anyone who can arrive without an identity.
 *
 * The shared bucket wins because the failure is visible and bounded — callers see
 * 429s and an operator sees the cause — whereas the alternative fails silently in
 * the direction of no protection. It should also be unreachable in practice:
 * Node always reports a peer address for a TCP connection, so this is the shape
 * of a preset that does not expose one rather than something a caller can arrange.
 */
export function rateLimitIdentity(input: IdentityInput): RateLimitIdentity {
  if (input.userId !== null && input.userId !== '') {
    return { kind: 'user', value: input.userId }
  }
  if (input.clientIp !== null) {
    return { kind: 'ip', value: input.clientIp }
  }
  return { kind: 'unknown', value: 'unknown' }
}

/**
 * `<rule>:<kind>:<value>`, each part percent-encoded.
 *
 * Every part is encoded for the reason `sessionStoreKey` gives: an unencoded `:`
 * in any of them could forge a key belonging to another bucket. The rule needs it
 * most — it is a path pattern, so it contains `/` and `*` — and the identity
 * needs it because a user id is application data.
 *
 * The rule leads so that every bucket for one policy shares a prefix, which makes
 * "what is this endpoint's traffic doing" a prefix scan rather than a walk of the
 * whole store. Same layout, and the same reason, as `session-store.ts` and
 * `idempotency.ts`.
 */
export function rateLimitStoreKey(rule: string, identity: RateLimitIdentity): string {
  return [rule, identity.kind, identity.value].map((part) => encodeURIComponent(part)).join(':')
}
