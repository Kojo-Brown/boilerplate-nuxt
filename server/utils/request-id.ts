/**
 * Request-id plumbing for `server/middleware/00.request-context.ts`.
 *
 * A correlation id is attacker-supplied input that ends up in two dangerous
 * places: a response header and (in any real deployment) the log stream. An
 * unvalidated one buys header injection through `\r\n`, log lines forged by
 * embedding newlines, and an unbounded string copied into every log record.
 * {@link isSafeRequestId} is the whole defence, so it is deliberately a
 * whitelist — the characters a UUID, a ULID or a trace id can contain — rather
 * than a blacklist of the sequences known to be harmful today.
 */

/**
 * Request headers consulted for a caller-supplied id, in order of preference.
 *
 * `x-request-id` is the conventional name. `x-correlation-id` is here because
 * `utils/api.ts` has been sending it from the browser on every `$fetch` since
 * the API-client item, and adopting it costs nothing.
 */
export const REQUEST_ID_HEADERS = ['x-request-id', 'x-correlation-id'] as const

/** The header the resolved id is echoed back on. */
export const RESPONSE_REQUEST_ID_HEADER = 'x-request-id'

/**
 * Alphanumerics plus `.`, `-` and `_`, 8 to 128 characters. A v4 UUID (36
 * chars) and a ULID (26) both fit; a CRLF, a space, a semicolon or a 4 KB blob
 * does not.
 */
const SAFE_REQUEST_ID = /^[A-Za-z0-9._-]{8,128}$/

export function isSafeRequestId(value: string | undefined | null): value is string {
  return typeof value === 'string' && SAFE_REQUEST_ID.test(value)
}
