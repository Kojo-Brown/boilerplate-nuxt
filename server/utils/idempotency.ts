import type { Storage } from 'unstorage'

/**
 * Idempotency keys: the dedupe store, and the rules that operate on it.
 *
 * ## The problem this exists for
 *
 * A client sends `POST /api/todos` and the connection dies before the response
 * arrives. It has no way to tell "the request never reached the server" from
 * "the todo was created and the 201 was lost" — those two are byte-for-byte
 * identical from the outside. Retrying risks a duplicate; not retrying risks
 * losing the write. Every HTTP client that retries automatically (an SDK's
 * backoff, a service mesh, a mobile app resuming on a new radio) is making that
 * gamble on the caller's behalf, usually without saying so.
 *
 * An `Idempotency-Key` header resolves it. The client mints one id per *logical
 * operation* and repeats it on every retry of that operation; the server records
 * the first outcome under that id and replays it verbatim to the retries. The
 * client's guess becomes a fact, and the retry it was already making becomes
 * safe.
 *
 * The semantics here follow `draft-ietf-httpapi-idempotency-key-header`: **409**
 * for a request that is still in flight, **422** for a key replayed with a
 * different payload. See `docs/idempotency.md`.
 *
 * ## What is stored, and what is not
 *
 * A record is only ever written for a response the handler **returned normally**
 * with a 2xx status. Everything else — a thrown `createError`, a 5xx, a status
 * the handler set itself outside 2xx — releases the claim instead, so a retry
 * re-executes.
 *
 * That is a deliberate simplification and not an oversight. A 4xx from schema
 * validation is a pure function of the request, so re-executing produces the
 * same 4xx and storing it buys nothing; a 5xx is exactly the case where the
 * client *should* get another attempt. What it costs is stated plainly: a
 * handler that throws after committing a side effect will commit it twice on a
 * retry, and no idempotency layer that only sees the throw can prevent that.
 * The fix for those handlers is a transaction, not a bigger record.
 *
 * ## Scope: a key belongs to a caller, not to a route
 *
 * The store key is `<scope>:<key>`, where the scope is the authenticated user
 * id. Two consequences, both intended:
 *
 *  - One caller's key can never address another caller's record, so a replay can
 *    never disclose a response the caller did not produce. That property comes
 *    from the key layout rather than from a check, which is why the scope leads.
 *  - Reusing one key across two *different* routes is an error (422 —
 *    {@link fingerprintRequest} folds in the method and path), not two
 *    independent records. A key names one operation. Stripe's API behaves the
 *    same way for the same reason.
 *
 * The user id leading also makes "every outstanding key for this user" a prefix
 * scan rather than a walk of the whole store, matching the layout
 * `server/utils/session-store.ts` uses.
 *
 * ## The claim is not a lock, and this module does not pretend otherwise
 *
 * `unstorage` has no compare-and-set — no `SETNX`, no CAS, nothing atomic across
 * its drivers. So {@link claimIdempotency} writes its claim and then reads it
 * back, and treats "the token that came back is not mine" as having lost a race.
 *
 * That is honest but not airtight. Two requests can still interleave as
 * write(A), read(A), write(B), read(B) and both proceed. What the read-back buys
 * is the size of the window: without it, two concurrent duplicates both execute
 * if they arrive within the *handler's* runtime — a database write, easily tens
 * of milliseconds. With it, they must arrive within one storage round trip of
 * each other, which is sub-millisecond on a local Redis.
 *
 * So the guarantee this feature actually offers is worth stating exactly:
 *
 *  - **A retry** — the case idempotency keys exist for, where the first attempt
 *    has already reached the store — is deduplicated deterministically.
 *  - **A true dead heat** is narrowed to a sub-millisecond window and not closed.
 *
 * Closing it needs a driver-level primitive (`SET key val NX`), which means
 * reaching past `unstorage` to `ioredis` and giving up the memory-driver test
 * path and the no-Redis deployment mode with it. `docs/idempotency.md` records
 * that trade rather than leaving the gap implied.
 *
 * ## Abandoned claims expire
 *
 * A process that dies mid-handler leaves an in-flight record behind. Without a
 * rule, every retry of that operation would get 409 until the record's retention
 * ran out — a day of a permanently stuck key, caused by a crash the client had
 * nothing to do with. A claim held for `claimTimeoutSeconds` or longer is
 * therefore treated as abandoned and taken over by the next request.
 *
 * The cost of that rule is the one case it cannot distinguish: a handler that is
 * genuinely still running after the timeout is indistinguishable from a dead
 * one, and its work may be duplicated. So the timeout is configuration
 * (`NUXT_IDEMPOTENCY_CLAIM_TIMEOUT_SECONDS`) and its default is comfortably
 * longer than any handler here.
 */

/** The request header a client sends its key on. Lowercase — h3 normalises. */
export const IDEMPOTENCY_KEY_HEADER = 'idempotency-key'

/**
 * Set on every response the wrapper handles: `true` when the body came from the
 * store, `false` when this request produced it.
 *
 * It is set in both cases on purpose. A header that only appears on replays
 * makes "no header" ambiguous between "freshly executed" and "idempotency was
 * not applied to this route at all", which is the one thing a client debugging a
 * duplicate needs to tell apart.
 */
export const IDEMPOTENCY_REPLAY_HEADER = 'idempotent-replay'

/** How long a completed record is kept. A day, matching Stripe's window. */
export const DEFAULT_RETENTION_SECONDS = 60 * 60 * 24

/** Retention floor. Below a minute a record can expire between two retries. */
export const MIN_RETENTION_SECONDS = 60

/**
 * Retention ceiling — seven days.
 *
 * Every stored record is a response body held in memory on the store. The
 * ceiling is what stops a misconfiguration turning that into an unbounded
 * accumulation, and a key older than a week is not a retry of anything.
 */
export const MAX_RETENTION_SECONDS = 60 * 60 * 24 * 7

/** How long an in-flight claim is honoured before a retry may take it over. */
export const DEFAULT_CLAIM_TIMEOUT_SECONDS = 60

/** Claim-timeout bounds. The floor is above any plausible handler runtime. */
export const MIN_CLAIM_TIMEOUT_SECONDS = 5
export const MAX_CLAIM_TIMEOUT_SECONDS = 600

/**
 * Keys a client may send: alphanumerics plus `.`, `-` and `_`, 8 to 128
 * characters — the same whitelist `server/utils/request-id.ts` applies to a
 * correlation id, and for the same reasons. A key is attacker-supplied input
 * that becomes part of a storage key and, in any real deployment, a log line.
 *
 * A v4 UUID (36 characters) and a ULID (26) both fit. A key short enough to
 * guess does not: the floor of 8 is what stops a client "deduplicating" on `1`,
 * which within one user's scope would collide with every other operation that
 * had the same idea.
 */
const SAFE_IDEMPOTENCY_KEY = /^[A-Za-z0-9._-]{8,128}$/

/** Byte separating the framed head fields in a fingerprint. See below. */
const FINGERPRINT_SEPARATOR = 0

export function isValidIdempotencyKey(value: string | undefined | null): value is string {
  return typeof value === 'string' && SAFE_IDEMPOTENCY_KEY.test(value)
}

/** The prefix every record for one caller shares — the argument to `getKeys()`. */
export function idempotencyScopePrefix(scope: string): string {
  return encodeURIComponent(scope)
}

/**
 * `<scope>:<key>`, both percent-encoded so a `:` in either cannot forge a key in
 * another caller's namespace — the same encoding rule as `sessionStoreKey`.
 */
export function idempotencyStoreKey(scope: string, key: string): string {
  return `${idempotencyScopePrefix(scope)}:${encodeURIComponent(key)}`
}

/** A response the wrapper captured and can replay. */
export interface StoredResponse {
  /** The status the handler produced. Always 2xx — see {@link isReplayableStatus}. */
  readonly status: number
  /**
   * The response body as JSON text, or `null` for a handler that returned
   * nothing (a 204).
   *
   * Text rather than the parsed value: a record round-trips through a store that
   * may serialise it (Redis) or may not (the memory driver), and storing the
   * already-serialised form means a replay cannot differ from the original
   * because of how the store happened to hold it.
   */
  readonly body: string | null
}

export interface InFlightRecord {
  readonly state: 'in-flight'
  /** Identifies the request that owns this claim. See {@link claimIdempotency}. */
  readonly claimToken: string
  readonly fingerprint: string
  readonly createdAt: number
}

export interface CompletedRecord {
  readonly state: 'completed'
  readonly claimToken: string
  readonly fingerprint: string
  readonly createdAt: number
  readonly completedAt: number
  readonly response: StoredResponse
}

/**
 * A discriminated union rather than one shape with optional members, so
 * "completed but carrying no response" is not a state the type permits and no
 * caller has to handle it.
 */
export type IdempotencyRecord = InFlightRecord | CompletedRecord

/** What {@link claimIdempotency} decided this request should do. */
export type IdempotencyDecision =
  /** No prior record (or the prior claim was abandoned): run the handler. */
  | { readonly outcome: 'proceed'; readonly claimToken: string }
  /** A completed record for this exact request: return its response. */
  | { readonly outcome: 'replay'; readonly response: StoredResponse }
  /** A live claim held by another request: 409. */
  | { readonly outcome: 'in-flight' }
  /** This key already names a different request: 422. */
  | { readonly outcome: 'fingerprint-mismatch' }

export interface IdempotencySettings {
  readonly retentionSeconds: number
  readonly claimTimeoutSeconds: number
}

/**
 * The subset of `useRuntimeConfig()` this module reads, declared structurally so
 * a test can pass a literal instead of a whole Nuxt config.
 *
 * The `| string` is not defensive noise — see the identical note in
 * `server/utils/storage.ts`. A `runtimeConfig` value overridden by a `NUXT_*`
 * environment variable arrives as a string, and a retention of `"3600"` handed
 * to a driver as a TTL is not a TTL.
 */
export interface IdempotencyRuntimeConfig {
  readonly idempotency?: {
    readonly retentionSeconds?: number | string
    readonly claimTimeoutSeconds?: number | string
  }
}

/** Clamps a configured second count into `[min, max]`, or falls back. */
function clampSeconds(
  value: number | string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const parsed = typeof value === 'string' ? Number(value) : value
  if (parsed === undefined || !Number.isFinite(parsed) || parsed <= 0) return fallback
  return Math.min(Math.max(Math.floor(parsed), min), max)
}

/**
 * Turns runtime config into the two durations this feature runs on.
 *
 * Out-of-range values are clamped rather than rejected. Both settings are
 * operational dials with no correct value this code could know, and the failure
 * a throw would produce — a server that will not boot because someone typed a
 * retention of two weeks — is worse than the one it prevents.
 */
export function resolveIdempotencySettings(config: IdempotencyRuntimeConfig): IdempotencySettings {
  return {
    retentionSeconds: clampSeconds(
      config.idempotency?.retentionSeconds,
      DEFAULT_RETENTION_SECONDS,
      MIN_RETENTION_SECONDS,
      MAX_RETENTION_SECONDS,
    ),
    claimTimeoutSeconds: clampSeconds(
      config.idempotency?.claimTimeoutSeconds,
      DEFAULT_CLAIM_TIMEOUT_SECONDS,
      MIN_CLAIM_TIMEOUT_SECONDS,
      MAX_CLAIM_TIMEOUT_SECONDS,
    ),
  }
}

/**
 * Only a 2xx is worth replaying.
 *
 * A 3xx is a pointer rather than an outcome, and everything from 400 up is
 * covered by the "release, do not store" rule documented at the top of this
 * file.
 */
export function isReplayableStatus(status: number): boolean {
  return status >= 200 && status < 300
}

export interface FingerprintInput {
  readonly method: string
  /** `event.path` — the request target, query string included. */
  readonly path: string
  /** The raw request body, or `undefined` for a request without one. */
  readonly body?: Uint8Array | undefined
}

/**
 * A SHA-256 of the request, so a key replayed with a different payload is
 * detectable.
 *
 * Without it, a client that reuses one key by accident — a hardcoded constant, a
 * key derived from a form id rather than a submission — gets the *first*
 * request's response for the *second* request's payload, and the write it
 * thought it made never happened. That failure is silent at every layer, which
 * is why the check is not optional.
 *
 * The method and path are hashed alongside the body because the key names one
 * operation: `POST /api/todos` and `PATCH /api/todos/1` under one key are two
 * operations, and the second is a 422 rather than a replay of the first.
 *
 * ### Framing
 *
 * The three fields are joined with a NUL byte, and the body — the only field
 * that can contain arbitrary bytes — goes last, so it needs no terminator. A
 * NUL cannot appear in either of the other two: a method is `[A-Z]+`, and a NUL
 * in a request target is rejected by the HTTP parser long before this code runs.
 * The encoding is therefore injective, which is the property the whole check
 * rests on — two different requests must not fingerprint alike.
 *
 * WebCrypto rather than `node:crypto`, matching `server/utils/ws-ticket.ts`, so
 * this runs unchanged on the Cloudflare and Deno presets.
 */
export async function fingerprintRequest(input: FingerprintInput): Promise<string> {
  const encoder = new TextEncoder()
  const head = encoder.encode(input.method.toUpperCase())
  const path = encoder.encode(input.path)
  const body = input.body ?? new Uint8Array(0)

  const framed = new Uint8Array(head.length + 1 + path.length + 1 + body.length)
  framed.set(head, 0)
  framed[head.length] = FINGERPRINT_SEPARATOR
  framed.set(path, head.length + 1)
  framed[head.length + 1 + path.length] = FINGERPRINT_SEPARATOR
  framed.set(body, head.length + 1 + path.length + 1)

  const digest = await crypto.subtle.digest('SHA-256', framed)

  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

export interface ClaimInput {
  /** Storage key from {@link idempotencyStoreKey}. */
  readonly key: string
  readonly fingerprint: string
  /** This request's claim token — a fresh `crypto.randomUUID()` per attempt. */
  readonly claimToken: string
  readonly settings: IdempotencySettings
  /** Injected so tests do not depend on the wall clock. */
  readonly now: number
}

/**
 * Decides what one request should do, and claims the key when the answer is
 * "run the handler".
 *
 * See the note at the top of this file on why the claim is a write followed by a
 * read-back rather than a compare-and-set, and exactly what that does and does
 * not guarantee.
 *
 * The claim record carries the fingerprint from the outset, not just on
 * completion, so a mismatch is caught against a request that is still running —
 * two different payloads sent concurrently under one key give one 422, not two
 * executions.
 */
export async function claimIdempotency(
  store: Storage<IdempotencyRecord>,
  input: ClaimInput,
): Promise<IdempotencyDecision> {
  const existing = await store.getItem(input.key)

  if (existing) {
    if (existing.fingerprint !== input.fingerprint) return { outcome: 'fingerprint-mismatch' }
    if (existing.state === 'completed') return { outcome: 'replay', response: existing.response }

    const ageSeconds = (input.now - existing.createdAt) / 1000
    if (ageSeconds < input.settings.claimTimeoutSeconds) return { outcome: 'in-flight' }
    // Older than the timeout: the request that took this claim is presumed dead,
    // so it is taken over below by the same write-then-verify path a fresh claim
    // uses. Two retries arriving together at that moment race each other exactly
    // as two fresh requests would, and one of them loses the read-back.
  }

  const claim: InFlightRecord = {
    state: 'in-flight',
    claimToken: input.claimToken,
    fingerprint: input.fingerprint,
    createdAt: input.now,
  }

  await store.setItem(input.key, claim, { ttl: input.settings.retentionSeconds })

  // The read-back. A concurrent claim that landed between the write above and
  // this read overwrote ours, and the request that wrote it will read its own
  // token and proceed — so this one must not.
  const confirmed = await store.getItem(input.key)
  if (!confirmed || confirmed.claimToken !== input.claimToken) return { outcome: 'in-flight' }

  return { outcome: 'proceed', claimToken: input.claimToken }
}

export interface CompleteInput {
  readonly key: string
  readonly claimToken: string
  readonly fingerprint: string
  readonly response: StoredResponse
  readonly settings: IdempotencySettings
  readonly now: number
}

/**
 * Stores the response a claimed request produced, so retries can replay it.
 *
 * Returns whether the record was written. It is not when the claim is no longer
 * this request's — it timed out and another attempt took it over — because
 * overwriting there would replace a record describing the *live* attempt with
 * one describing an attempt that was already presumed dead, and hand every
 * subsequent retry the older of two answers.
 */
export async function completeIdempotency(
  store: Storage<IdempotencyRecord>,
  input: CompleteInput,
): Promise<boolean> {
  const current = await store.getItem(input.key)
  if (current && current.claimToken !== input.claimToken) return false

  const record: CompletedRecord = {
    state: 'completed',
    claimToken: input.claimToken,
    fingerprint: input.fingerprint,
    // A record the claim outlived (an expiry between claim and completion) is
    // rewritten from scratch rather than abandoned: the response is real and
    // worth storing, and its own timestamps are the honest ones for it.
    createdAt: current?.createdAt ?? input.now,
    completedAt: input.now,
    response: input.response,
  }

  await store.setItem(input.key, record, { ttl: input.settings.retentionSeconds })

  return true
}

/**
 * Drops a claim this request is not going to complete, so the next attempt runs
 * instead of waiting out the claim timeout.
 *
 * Only an in-flight record still held by this request is removed. A completed
 * record is never deleted here — that would discard a stored response — and
 * neither is a claim another attempt has since taken over.
 */
export async function releaseIdempotencyClaim(
  store: Storage<IdempotencyRecord>,
  key: string,
  claimToken: string,
): Promise<boolean> {
  const current = await store.getItem(key)
  if (!current || current.state !== 'in-flight' || current.claimToken !== claimToken) return false

  await store.removeItem(key)

  return true
}
