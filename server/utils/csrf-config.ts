import { clampCsrfTtl, parseCsrfOrigins, DEFAULT_CSRF_TTL_SECONDS } from '~/server/utils/csrf'

/**
 * The CSRF half of `runtimeConfig`, read once and memoised.
 *
 * Same seam, and the same reasoning, as `server/utils/ws-config.ts`:
 * `server/utils/csrf.ts` takes a key and an origin list as arguments so it can
 * be exercised with literals, and this is the only module in the defence that
 * calls `useRuntimeConfig()`.
 *
 * ## The memo, and why module state is acceptable here
 *
 * `CLAUDE.md` forbids module-scope mutable state in `composables/`, `utils/` and
 * `stores/`, and `eslint-rules/composable-design.mjs` enforces it — deliberately
 * not over `server/`, because a Nitro handler already runs per request in a
 * process that serves many. The rule exists to stop one visitor's data reaching
 * another's page. What is cached here is derived from configuration: identical
 * for every request by construction, holding nothing about any caller, and keyed
 * on the secret it came from so a config change (or a test switching secrets)
 * derives again rather than serving a stale key.
 *
 * The alternative is an HKDF derivation plus an `importKey` per request. Both
 * are sub-millisecond and it would be defensible — but this runs on *every*
 * state-changing request, including the unauthenticated ones an attacker can
 * make in a loop, and a per-request key stretch on that path is a cost worth not
 * having.
 */

/** HKDF context string. Changing it invalidates every outstanding token. */
const CSRF_KEY_INFO = 'nuxt-csrf-double-submit-v1'

/** The shape of `useRuntimeConfig()` this module reads. */
export interface CsrfRuntimeConfig {
  readonly security?: {
    readonly csrf?: {
      readonly tokenTtlSeconds?: number | string
      readonly allowedOrigins?: string | readonly string[]
    }
  }
  readonly session?: {
    readonly password?: string
  }
}

export interface CsrfConfig {
  /** HMAC-SHA256 key, ready for `crypto.subtle.sign`. */
  readonly key: CryptoKey
  readonly ttlSeconds: number
  readonly allowedOrigins: readonly string[]
}

/**
 * Derives the token-signing key from the session password with HKDF-SHA256.
 *
 * Not a new secret, and not the session password used directly. HKDF's output
 * tells you nothing about its input and {@link CSRF_KEY_INFO} separates this key
 * from the WebSocket ticket key derived from the same password in
 * `server/utils/ws-ticket.ts`, so one deployed secret still yields three
 * cryptographically unrelated uses: sealing the session, signing a handshake
 * ticket, and signing this token.
 *
 * There is deliberately no `NUXT_SECURITY_CSRF_SECRET`. A ticket secret is
 * separately settable because a ticket travels in a URL and an operator may want
 * to rotate it on its own schedule; this token's lifetime is already bounded and
 * rotating it independently of the session password buys nothing but another
 * variable that can be left unset.
 *
 * WebCrypto rather than `node:crypto`, so the module runs unchanged on the
 * Cloudflare and Deno presets — the same reason `deriveTicketKey` gives.
 */
export async function deriveCsrfKey(secret: string): Promise<CryptoKey> {
  if (secret.length < 32) {
    throw new Error(
      'The CSRF token key is derived from runtimeConfig.session.password, which must be at ' +
        'least 32 characters. Set NUXT_SESSION_PASSWORD.',
    )
  }

  const material = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    'HKDF',
    false,
    ['deriveBits'],
  )

  const bits = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(0),
      info: new TextEncoder().encode(CSRF_KEY_INFO),
    },
    material,
    256,
  )

  return crypto.subtle.importKey('raw', bits, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
}

/**
 * Resolves what the gate needs from a config object.
 *
 * Takes the object rather than calling `useRuntimeConfig()`, so it is a function
 * of its input — the same reason `resolveSecurityConfig` and
 * `resolveStorageMounts` do.
 */
export async function resolveCsrfConfig(config: CsrfRuntimeConfig): Promise<CsrfConfig> {
  const secret = config.session?.password?.trim() ?? ''

  return {
    key: await deriveCsrfKey(secret),
    ttlSeconds: clampCsrfTtl(config.security?.csrf?.tokenTtlSeconds ?? DEFAULT_CSRF_TTL_SECONDS),
    allowedOrigins: parseCsrfOrigins(config.security?.csrf?.allowedOrigins),
  }
}

/** The memo. Keyed on the secret so a changed config is never served stale. */
let cached: { readonly secret: string; readonly config: Promise<CsrfConfig> } | null = null

/**
 * {@link resolveCsrfConfig} against the live `runtimeConfig`, computed once.
 *
 * The promise itself is cached rather than its result, so two requests racing on
 * a cold process share one derivation instead of starting two.
 */
export function useCsrfConfig(): Promise<CsrfConfig> {
  const runtime = useRuntimeConfig() as unknown as CsrfRuntimeConfig
  const secret = runtime.session?.password?.trim() ?? ''

  if (cached?.secret !== secret) {
    cached = { secret, config: resolveCsrfConfig(runtime) }
  }

  return cached.config
}

/** Drops the memo. Exists for tests and for nothing else. */
export function resetCsrfConfigCache(): void {
  cached = null
}
