import { routeRules as projectRouteRules } from '~/route-rules.config'

/**
 * The security response headers, built as data.
 *
 * Nothing in here reads `useRuntimeConfig()`, touches an `H3Event`, or knows
 * that Nitro exists. It takes a resolved configuration, a nonce (or the absence
 * of one) and two booleans, and returns the header map
 * `server/middleware/05.security-headers.ts` sets — the same seam
 * `server/utils/ws-config.ts` describes for the WebSocket code, and for the same
 * reason: a policy string is worth asserting on character by character, and a
 * test should be able to do that with literals rather than a fake request.
 *
 * ## Why the nonce can be absent
 *
 * A nonce is per response. It only works if the value in the header and the
 * value in the HTML were produced by the same render, which is true for every
 * page this app renders on demand and false for every page whose HTML is
 * **shared** — prerendered at build time, or cached by an `swr` / `isr` route
 * rule and replayed to whoever asks next. Those bodies outlive the request that
 * produced them, so a fresh per-request nonce in the header would match nothing
 * in the body and would block the page's own bootstrap scripts.
 *
 * This is the same constraint `docs/nitro-route-rules.md` and
 * `server/utils/access-policy.ts` already record from the other direction: a
 * response that is cached or prerendered cannot be per-user. It cannot be
 * per-request either, and a nonce is nothing but a per-request value.
 *
 * So shared HTML gets a policy with `'unsafe-inline'` where a rendered page gets
 * `'nonce-…'`. That is a real weakening and is written down as one in
 * `docs/security-headers.md`. What keeps it contained is that the set of shared
 * paths is not a hand-maintained list — it is derived from `route-rules.config.ts`
 * by {@link sharedHtmlPatterns}, so a page stops being an exception the moment
 * its route rule goes away, and `server/plugins/security-headers.ts` fails the
 * build if a route is prerendered without appearing here.
 *
 * ## What is deliberately not here
 *
 * `Cross-Origin-Embedder-Policy`. It is the header that unlocks
 * `SharedArrayBuffer`, and it costs every cross-origin subresource a matching
 * `Cross-Origin-Resource-Policy` — including anything a consumer of this
 * boilerplate adds later. Shipping it by default would turn an ordinary third
 * party `<img>` into a blank box, so it belongs in the project that needs it.
 */

/** How the Content-Security-Policy is delivered. */
export type CspMode = 'enforce' | 'report-only' | 'off'

/** The `security` half of `runtimeConfig`, as it arrives (env vars are strings). */
export interface SecurityRuntimeConfig {
  readonly security?: {
    readonly csp?: {
      readonly mode?: string
      readonly reportUri?: string
      readonly connectSrc?: string | readonly string[]
      readonly imgSrc?: string | readonly string[]
      readonly frameAncestors?: string | readonly string[]
    }
    readonly hsts?: {
      readonly maxAgeSeconds?: number | string
      readonly includeSubdomains?: boolean | string
      readonly preload?: boolean | string
    }
  }
}

export interface HstsConfig {
  readonly maxAgeSeconds: number
  readonly includeSubdomains: boolean
  readonly preload: boolean
}

export interface SecurityConfig {
  readonly cspMode: CspMode
  /** Empty when no violation collector is configured. */
  readonly reportUri: string
  /** Extra origins appended to the matching directive. */
  readonly connectSrc: readonly string[]
  readonly imgSrc: readonly string[]
  /** Who may frame this app. Empty means `'none'`. */
  readonly frameAncestors: readonly string[]
  readonly hsts: HstsConfig
}

/** Two years, the ceiling the HSTS preload list asks for. */
export const MAX_HSTS_MAX_AGE_SECONDS = 63_072_000

/** One year, the floor the preload list requires and a sane production default. */
export const DEFAULT_HSTS_MAX_AGE_SECONDS = 31_536_000

const CSP_MODES: readonly CspMode[] = ['enforce', 'report-only', 'off']

/**
 * A source expression this project will put in a header.
 *
 * Deliberately narrower than the CSP grammar: schemes, hosts, ports, paths and
 * wildcards, and nothing that could end a directive or a header. A comma or a
 * semicolon in an environment variable would otherwise let whoever sets it
 * append directives of their own — `NUXT_SECURITY_CSP_IMG_SRC='x; script-src *'`
 * is a response-header injection with a friendly name. Quoted keywords
 * (`'self'`, `'unsafe-inline'`) are not accepted either: every keyword this
 * policy uses is decided in code below, and an operator adding one through
 * configuration is exactly the change that should be a code review.
 */
const SOURCE_EXPRESSION = /^[A-Za-z0-9][A-Za-z0-9.*:/_?=&%+~@[\]-]*$/

/** Longest source expression accepted. Far past any real origin. */
const MAX_SOURCE_LENGTH = 256

/**
 * Splits a comma-separated (or already-split) list into validated sources.
 *
 * Anything that fails {@link SOURCE_EXPRESSION} is dropped rather than escaped:
 * a value that cannot be represented is a misconfiguration, and silently
 * shipping a mangled origin would be worse than shipping the default policy.
 * Duplicates collapse so the header stays readable.
 */
export function parseSourceList(value: string | readonly string[] | undefined): string[] {
  if (value === undefined) return []

  const raw = typeof value === 'string' ? value.split(',') : value
  const seen = new Set<string>()

  for (const entry of raw) {
    const source = String(entry).trim()
    if (source === '' || source.length > MAX_SOURCE_LENGTH) continue
    if (!SOURCE_EXPRESSION.test(source)) continue
    seen.add(source)
  }

  return [...seen]
}

/**
 * Clamps `max-age` to 0…{@link MAX_HSTS_MAX_AGE_SECONDS}.
 *
 * Zero is kept rather than treated as "off", because it is the only way back:
 * a browser that has seen this site's HSTS header remembers it for the whole
 * `max-age`, and the documented retreat is to serve `max-age=0` until that
 * memory expires. Removing the header instead leaves every previous visitor
 * pinned to HTTPS with no way to tell them otherwise.
 */
export function clampHstsMaxAge(value: number | string | undefined): number {
  const parsed = typeof value === 'string' ? Number(value) : value
  if (parsed === undefined || !Number.isFinite(parsed)) return DEFAULT_HSTS_MAX_AGE_SECONDS
  return Math.min(Math.max(Math.trunc(parsed), 0), MAX_HSTS_MAX_AGE_SECONDS)
}

/** Env vars arrive as strings, so `'false'` has to mean false. */
function asBoolean(value: boolean | string | undefined, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value
  if (value === undefined) return fallback
  const normalised = value.trim().toLowerCase()
  if (normalised === 'true' || normalised === '1') return true
  if (normalised === 'false' || normalised === '0') return false
  return fallback
}

/** A report endpoint has to be a same-origin path or an absolute http(s) URL. */
function parseReportUri(value: string | undefined): string {
  const uri = value?.trim() ?? ''
  if (uri === '' || !SOURCE_EXPRESSION.test(uri.replace(/^\//, 'x'))) return ''
  if (uri.startsWith('/')) return uri
  return /^https?:\/\//.test(uri) ? uri : ''
}

/**
 * Normalises `runtimeConfig.security` into the shape the builders take.
 *
 * Takes the config object rather than calling `useRuntimeConfig()` — same reason
 * as `resolveWsConfig` and `resolveStorageMounts`: a function of its input can
 * be tested with a literal.
 */
export function resolveSecurityConfig(config: SecurityRuntimeConfig): SecurityConfig {
  const csp = config.security?.csp
  const hsts = config.security?.hsts
  const mode = csp?.mode?.trim().toLowerCase()

  return {
    cspMode: CSP_MODES.find((candidate) => candidate === mode) ?? 'enforce',
    reportUri: parseReportUri(csp?.reportUri),
    connectSrc: parseSourceList(csp?.connectSrc),
    imgSrc: parseSourceList(csp?.imgSrc),
    frameAncestors: parseSourceList(csp?.frameAncestors),
    hsts: {
      maxAgeSeconds: clampHstsMaxAge(hsts?.maxAgeSeconds),
      includeSubdomains: asBoolean(hsts?.includeSubdomains, true),
      preload: asBoolean(hsts?.preload, false),
    },
  }
}

export interface PolicyInput {
  /** The per-response nonce, or `null` for shared HTML — see the module note. */
  readonly nonce: string | null
  /** `import.meta.dev`. Relaxes the two directives Vite's dev server needs. */
  readonly dev: boolean
  /** Whether the request arrived over TLS. Gates `upgrade-insecure-requests`. */
  readonly secure: boolean
  readonly config: SecurityConfig
}

function scriptSources({ nonce, dev }: PolicyInput): string[] {
  const sources = ["'self'"]

  // `'unsafe-inline'` is ignored by any browser that understands a nonce, so
  // these two are alternatives, never a belt-and-braces pair: adding both to a
  // rendered page would silently drop the nonce back to "inline scripts are
  // allowed". Shared HTML takes the second branch because it has no nonce to
  // offer — see the module note.
  if (nonce) sources.push(`'nonce-${nonce}'`)
  else sources.push("'unsafe-inline'")

  // Vite's dev transform compiles modules through `new Function`. This is the
  // one directive that is weaker in development than in production, and it is
  // why `pnpm dev` is not where this policy should be signed off — build and
  // `pnpm preview` are.
  if (dev) sources.push("'unsafe-eval'")

  return sources
}

function styleSources({ nonce, dev }: PolicyInput): string[] {
  // Vite injects dev styles by creating `<style>` elements from JavaScript,
  // which `style-src` checks like any other inline style. There is no nonce to
  // give them — they are created after the document was parsed — so development
  // has to allow inline styles outright.
  if (dev) return ["'self'", "'unsafe-inline'"]
  return nonce ? ["'self'", `'nonce-${nonce}'`] : ["'self'", "'unsafe-inline'"]
}

/**
 * Builds the policy string.
 *
 * Directive order is fixed so the header is diffable between two deployments and
 * so a test can assert the whole string rather than picking it apart.
 */
export function buildContentSecurityPolicy(input: PolicyInput): string {
  const { config, secure } = input

  const directives: [string, string[]][] = [
    ['default-src', ["'self'"]],
    // `'none'` on both: nothing in this app rewrites its own `<base>` or embeds
    // a plugin, and these two are the cheapest directives in CSP to get right.
    ['base-uri', ["'none'"]],
    ['object-src', ["'none'"]],
    ['script-src', scriptSources(input)],
    ['style-src', styleSources(input)],
    // Vue writes `:style` bindings out as `style` attributes, which `style-src`
    // would block and which no nonce can cover — an attribute has nowhere to put
    // one. `style-src-attr` is the directive that exists for exactly this split,
    // and an attacker who can already set an attribute on an element has a far
    // better primitive available than CSS.
    ['style-src-attr', ["'unsafe-inline'"]],
    ['img-src', ["'self'", 'data:', 'blob:', ...config.imgSrc]],
    ['font-src', ["'self'", 'data:']],
    // `'self'` covers the same-origin WebSocket in `server/api/ws/echo.ts`:
    // CSP 3 matches `ws:`/`wss:` against a `http:`/`https:` origin, which is
    // what every browser that ships nonces also implements.
    ['connect-src', ["'self'", ...config.connectSrc]],
    ['media-src', ["'self'"]],
    ['worker-src', ["'self'", 'blob:']],
    ['manifest-src', ["'self'"]],
    ['frame-src', ["'none'"]],
    ['frame-ancestors', config.frameAncestors.length > 0 ? [...config.frameAncestors] : ["'none'"]],
    ['form-action', ["'self'"]],
  ]

  const serialised = directives.map(([name, sources]) => `${name} ${sources.join(' ')}`)

  // Only over TLS. On a plain-HTTP dev server this directive would rewrite every
  // `http://localhost` subresource to `https://` and break the page.
  if (secure) serialised.push('upgrade-insecure-requests')

  if (config.reportUri) serialised.push(`report-uri ${config.reportUri}`)

  return serialised.join('; ')
}

/** Capabilities this app never uses, denied for itself and every frame. */
const PERMISSIONS_POLICY = [
  'accelerometer=()',
  'autoplay=()',
  'camera=()',
  'display-capture=()',
  'encrypted-media=()',
  'geolocation=()',
  'gyroscope=()',
  'magnetometer=()',
  'microphone=()',
  'midi=()',
  'payment=()',
  'usb=()',
  'xr-spatial-tracking=()',
].join(', ')

/** Serialises `Strict-Transport-Security` from the resolved HSTS settings. */
export function buildStrictTransportSecurity(hsts: HstsConfig): string {
  const parts = [`max-age=${hsts.maxAgeSeconds}`]
  if (hsts.includeSubdomains) parts.push('includeSubDomains')
  // `preload` is only meaningful alongside `includeSubDomains` and a max-age of
  // at least a year; submitting a domain that does not satisfy both is rejected
  // by the preload list, so the flag is dropped rather than shipped as a lie.
  if (
    hsts.preload &&
    hsts.includeSubdomains &&
    hsts.maxAgeSeconds >= DEFAULT_HSTS_MAX_AGE_SECONDS
  ) {
    parts.push('preload')
  }
  return parts.join('; ')
}

/**
 * The complete header map for one response.
 *
 * `Strict-Transport-Security` is present only on a TLS request. A browser
 * ignores it on plain HTTP anyway, so this changes no behaviour — what it buys
 * is that `curl -I http://localhost:3000` shows what the browser actually acts
 * on instead of a header that reads as active and is not.
 */
export function buildSecurityHeaders(input: PolicyInput): Record<string, string> {
  const { config, secure } = input

  const headers: Record<string, string> = {
    'x-content-type-options': 'nosniff',
    // Redundant with `frame-ancestors` in every browser that supports CSP 2,
    // and kept because it costs 22 bytes and is what the older scanners and
    // corporate proxies in front of this app still look for.
    'x-frame-options': 'DENY',
    'referrer-policy': 'strict-origin-when-cross-origin',
    'permissions-policy': PERMISSIONS_POLICY,
    'cross-origin-opener-policy': 'same-origin',
    // Applies to no-cors subresource loads only, so it does not affect the CORS
    // endpoint in `server/api/route-rules/cors.get.ts` — a `fetch()` that sends
    // an `Origin` and gets `access-control-allow-origin` back is never checked
    // against this header.
    'cross-origin-resource-policy': 'same-origin',
  }

  if (config.cspMode !== 'off') {
    const header =
      config.cspMode === 'report-only'
        ? 'content-security-policy-report-only'
        : 'content-security-policy'
    headers[header] = buildContentSecurityPolicy(input)
  }

  if (secure) headers['strict-transport-security'] = buildStrictTransportSecurity(config.hsts)

  return headers
}

/**
 * Whether the request reached this process over TLS.
 *
 * `x-forwarded-proto` is trusted when present. That is normally a thing to be
 * careful about, and here it is not: the single decision it drives is whether to
 * send `Strict-Transport-Security`, and a browser on a plain-HTTP connection
 * ignores that header no matter who asked for it. Spoofing the header buys an
 * attacker a header their own browser discards.
 */
export function isSecureRequest(input: {
  readonly forwardedProto?: string | undefined
  readonly socket?: unknown
}): boolean {
  const forwarded = input.forwardedProto?.split(',')[0]?.trim().toLowerCase()
  if (forwarded) return forwarded === 'https'
  return socketIsEncrypted(input.socket)
}

/**
 * Whether a Node socket is a TLS one.
 *
 * Structural rather than an `instanceof TLSSocket`: `req.socket` is typed as
 * `net.Socket`, `encrypted` is the property `tls.TLSSocket` adds, and a preset
 * that is not the Node server has no socket here at all. Probing for the
 * property covers all three without importing `node:tls` into a module that
 * otherwise has no runtime dependencies.
 */
function socketIsEncrypted(socket: unknown): boolean {
  if (typeof socket !== 'object' || socket === null) return false
  if (!('encrypted' in socket)) return false
  return socket.encrypted === true
}

type RouteRules = typeof projectRouteRules

/**
 * The route-rule keys whose **HTML** is shared between requests.
 *
 * A rule qualifies when it prerenders the route or caches it (`swr` / `isr`) and
 * the route is not under `/api` — a cached JSON endpoint has no inline script to
 * authorise, so it keeps the ordinary policy and the stale nonce its cached
 * headers may carry means nothing to it.
 *
 * Derived rather than listed so the two files cannot drift: delete a route rule
 * and the page stops being an exception on the next boot.
 */
export function sharedHtmlPatterns(rules: RouteRules = projectRouteRules): string[] {
  return Object.entries(rules)
    .filter(([pattern, rule]) => {
      if (pattern.startsWith('/api')) return false
      if (rule === undefined || rule === null) return false
      return rule.prerender === true || rule.swr !== undefined || rule.isr !== undefined
    })
    .map(([pattern]) => pattern)
}

/**
 * Whether an already-normalised pathname (see `normalisePathname`) is served
 * from shared HTML and therefore cannot carry a nonce.
 *
 * Matching mirrors `server/utils/access-policy.ts`: an exact key, or a prefix
 * ending in `/**` that also matches everything below it.
 */
export function servesSharedHtml(pathname: string, rules: RouteRules = projectRouteRules): boolean {
  return sharedHtmlPatterns(rules).some((pattern) => {
    if (!pattern.endsWith('/**')) return pathname === pattern
    const prefix = pattern.slice(0, -3)
    if (prefix === '') return true
    return pathname === prefix || pathname.startsWith(`${prefix}/`)
  })
}
