import {
  clampTicketTtl,
  deriveTicketKey,
  DEFAULT_TICKET_TTL_SECONDS,
} from '~/server/utils/ws-ticket'
import { parseAllowedOrigins } from '~/server/utils/ws-handshake'

/**
 * The WebSocket half of `runtimeConfig`, read once and memoised.
 *
 * This is the seam where the WebSocket code stops depending on Nitro:
 * `ws-ticket.ts` and `ws-handshake.ts` take a key and an origin list as
 * arguments and can be exercised with literals, and this module is the only
 * place that calls `useRuntimeConfig()`.
 *
 * ## The one piece of module-scope state in `server/`
 *
 * {@link useWsConfig} caches the derived key. `CLAUDE.md` forbids module-scope
 * mutable state in `composables/`, `utils/` and `stores/` — enforced by
 * `eslint-rules/composable-design.mjs`, which deliberately does not cover
 * `server/` because a Nitro handler already runs per request in a process that
 * serves many. The rule exists to stop one visitor's data reaching another's
 * page, and the cached value here is derived from configuration: it is identical
 * for every request by construction, holds nothing about a caller, and is keyed
 * on the secret it came from so a config change (or a test switching secrets)
 * derives again rather than serving a stale key.
 *
 * The alternative is an HKDF derivation per handshake. That is a fraction of a
 * millisecond and would be defensible — but a WebSocket upgrade is exactly the
 * request an attacker can make in a tight loop without ever authenticating, and
 * a per-connection key stretch on an unauthenticated path is a cost worth not
 * having.
 */

/** The shape of `useRuntimeConfig()` this module reads. */
export interface WsRuntimeConfig {
  readonly ws?: {
    readonly ticketSecret?: string
    readonly ticketTtlSeconds?: number | string
    readonly allowedOrigins?: string | readonly string[]
  }
  readonly session?: {
    readonly password?: string
  }
}

export interface WsConfig {
  /** HMAC key for ticket signatures. */
  readonly key: Uint8Array
  readonly ticketTtlSeconds: number
  readonly allowedOrigins: readonly string[]
}

/**
 * Resolves the config a ticket needs, deriving the signing key.
 *
 * Takes the config object rather than calling `useRuntimeConfig()` so it is a
 * function of its input — the same reason `resolveStorageMounts` in
 * `server/utils/storage.ts` does.
 *
 * The secret falls back to `session.password` deliberately. A boilerplate that
 * needs a second mandatory environment variable before its WebSocket works is a
 * boilerplate whose WebSocket example does not run, and HKDF's domain separation
 * (see {@link deriveTicketKey}) means sharing the secret does not share a key.
 * `NUXT_WS_TICKET_SECRET` is there for operators who want the two to rotate
 * independently.
 */
export async function resolveWsConfig(config: WsRuntimeConfig): Promise<WsConfig> {
  const secret = config.ws?.ticketSecret?.trim() || config.session?.password?.trim() || ''

  if (secret === '') {
    throw new Error(
      'No secret to sign WebSocket tickets with. Set NUXT_SESSION_PASSWORD (at least 32 ' +
        'characters), or NUXT_WS_TICKET_SECRET for a key independent of the session cookie.',
    )
  }

  return {
    key: await deriveTicketKey(secret),
    ticketTtlSeconds: clampTicketTtl(config.ws?.ticketTtlSeconds ?? DEFAULT_TICKET_TTL_SECONDS),
    allowedOrigins: parseAllowedOrigins(config.ws?.allowedOrigins),
  }
}

/** The memo. Keyed on the secret so a changed config is never served stale. */
let cached: { readonly secret: string; readonly config: Promise<WsConfig> } | null = null

/**
 * {@link resolveWsConfig} against the live `runtimeConfig`, computed once.
 *
 * The promise itself is cached rather than its result, so two handshakes racing
 * on a cold process share one derivation instead of starting two.
 */
export function useWsConfig(): Promise<WsConfig> {
  const runtime = useRuntimeConfig() as unknown as WsRuntimeConfig
  const secret = runtime.ws?.ticketSecret?.trim() || runtime.session?.password?.trim() || ''

  if (cached?.secret !== secret) {
    cached = { secret, config: resolveWsConfig(runtime) }
  }

  return cached.config
}

/** Drops the memo. Exists for tests and for nothing else. */
export function resetWsConfigCache(): void {
  cached = null
}
