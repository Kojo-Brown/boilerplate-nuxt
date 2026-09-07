import type { H3Event } from 'h3'
import type { Storage } from 'unstorage'

import {
  claimIdempotency,
  completeIdempotency,
  fingerprintRequest,
  idempotencyStoreKey,
  isReplayableStatus,
  isValidIdempotencyKey,
  releaseIdempotencyClaim,
  resolveIdempotencySettings,
  IDEMPOTENCY_KEY_HEADER,
  IDEMPOTENCY_REPLAY_HEADER,
  type IdempotencyRecord,
  type StoredResponse,
} from '~/server/utils/idempotency'
import { requireAuth } from '~/server/utils/request-auth'
import { IDEMPOTENCY_BASE } from '~/server/utils/storage'

/**
 * `defineIdempotentHandler` — the seam where the dedupe store meets Nitro.
 *
 * `server/utils/idempotency.ts` holds the rules and the record shapes and has no
 * Nitro dependency, so it is unit-tested against a real in-memory `unstorage`.
 * This file is the part that cannot be: it reads the header, reads the body,
 * resolves the caller, owns the `useStorage()` lookup, and turns a decision into
 * a status code. It is the same split as `cache-tags.ts` / `cached-route.ts`.
 *
 * ```ts
 * export default defineIdempotentHandler(async (event) => {
 *   const db = useDb()
 *   return { data: await db.insert(todos).values(…).returning() }
 * })
 * ```
 *
 * ## Opt-in per request, not per route
 *
 * A request with no `Idempotency-Key` runs straight through. The header is the
 * client's declaration that this call is a retry-able unit of work, and only the
 * client knows that — the same `POST /api/todos` is one operation when a form is
 * submitted and a different one each time a script loops.
 *
 * Requiring the header instead would be a breaking change for every existing
 * caller, and would be answering a question the server cannot answer. What the
 * server owes in return is that the header is never *silently* ignored:
 * {@link IDEMPOTENCY_REPLAY_HEADER} is set on every response this wrapper
 * handles, so a client can confirm the feature is on before it depends on it.
 *
 * ## Reading the body here does not consume it
 *
 * The fingerprint needs the raw request body, and the handler needs it too.
 * `readRawBody` caches its result on the request (h3 1.15 stores it under a
 * symbol on `event.node.req`), so the `readBody` inside the handler is served
 * from that cache. Reading it as bytes rather than text is what keeps that true
 * for a handler that reaches for `readMultipartFormData` instead.
 *
 * ## An unreachable store fails the request
 *
 * This is the opposite of the stance `server/utils/session-store.ts` takes, and
 * the difference is deliberate rather than an inconsistency.
 *
 * There, the store *adds* revocation on top of a cookie that already grants
 * access, so failing open costs exactly what the app had before the registry
 * existed. Here, the store **is** the guarantee. A client sends an
 * `Idempotency-Key` precisely because executing twice is not acceptable to it;
 * quietly downgrading to at-least-once when Redis blinks would give it the
 * duplicate it asked not to have, and it would never know. So a claim that
 * cannot be taken is a 503 with `Retry-After` — an answer the client's retry
 * logic already understands, on a request it was already prepared to repeat.
 *
 * Requests **without** the header are untouched by this: the store is never
 * consulted for them, so a store outage does not take the route down.
 */

/** Options for {@link defineIdempotentHandler}. */
export interface IdempotentHandlerOptions {
  /**
   * The namespace a key belongs to. Defaults to the authenticated user's id.
   *
   * Override it only for a route whose caller is identified some other way. It
   * must never return a constant: the scope is what stops one caller's key
   * addressing another's record, so a shared scope would let any caller replay
   * any other's response by guessing a key.
   */
  readonly scope?: (event: H3Event) => string
}

/** Seconds a 503 from this wrapper asks the client to wait. */
const RETRY_AFTER_SECONDS = 1

/**
 * The `idempotency` base of Nitro's storage.
 *
 * Lives here rather than in `idempotency.ts` so that module stays free of both
 * Nitro auto-imports and of an import back into `storage.ts`, which reads its
 * retention setting — the cycle that would otherwise create.
 */
export function useIdempotencyStore(): Storage<IdempotencyRecord> {
  return useStorage<IdempotencyRecord>(IDEMPOTENCY_BASE)
}

/** Reads the two durations out of runtime config, clamped. */
function settings() {
  return resolveIdempotencySettings(useRuntimeConfig())
}

/**
 * Serialises what the handler returned into the form a replay will re-emit.
 *
 * `undefined` (a handler that returns nothing, i.e. a 204) is stored as `null`
 * rather than as the string `"undefined"`, which is what `JSON.stringify`
 * produces for it and is not JSON.
 */
function captureResponse(status: number, value: unknown): StoredResponse {
  return { status, body: value === undefined ? null : JSON.stringify(value) }
}

/**
 * Wraps a mutating handler so a repeated `Idempotency-Key` replays the first
 * response instead of executing again.
 *
 * Returns an ordinary event handler; a route file default-exports it exactly as
 * it would `defineEventHandler`.
 */
export function defineIdempotentHandler<T>(
  handler: (event: H3Event) => T | Promise<T>,
  options: IdempotentHandlerOptions = {},
) {
  return defineEventHandler(async (event: H3Event): Promise<T> => {
    const supplied = getRequestHeader(event, IDEMPOTENCY_KEY_HEADER)

    if (supplied === undefined) return handler(event)

    if (!isValidIdempotencyKey(supplied)) {
      throw createError({
        statusCode: 400,
        message:
          `Invalid ${IDEMPOTENCY_KEY_HEADER}. Expected 8 to 128 characters of ` +
          '[A-Za-z0-9._-] — a UUID is the usual choice.',
        data: { requestId: event.context.requestId },
      })
    }

    // Throws a 500 naming `server/utils/access-policy.ts` if this route is not
    // one the auth middleware manages — see `requireAuth`. That is the right
    // failure: without a caller there is no scope, and a shared scope would make
    // one caller's key readable by another.
    const scope = options.scope?.(event) ?? requireAuth(event).user.id
    const key = idempotencyStoreKey(scope, supplied)
    const store = useIdempotencyStore()
    const resolved = settings()
    const claimToken = crypto.randomUUID()

    const fingerprint = await fingerprintRequest({
      method: event.method,
      path: event.path,
      body: await readRawBody(event, false),
    })

    let decision
    try {
      decision = await claimIdempotency(store, {
        key,
        fingerprint,
        claimToken,
        settings: resolved,
        now: Date.now(),
      })
    } catch (error) {
      console.error('[idempotency] dedupe store unreachable, refusing the request:', error)
      setResponseHeader(event, 'retry-after', RETRY_AFTER_SECONDS)
      throw createError({
        statusCode: 503,
        message: 'Idempotency store unavailable. Retry with the same Idempotency-Key.',
        data: { requestId: event.context.requestId },
      })
    }

    if (decision.outcome === 'fingerprint-mismatch') {
      throw createError({
        statusCode: 422,
        message:
          `This ${IDEMPOTENCY_KEY_HEADER} was already used for a different request. ` +
          'A key names one operation — use a new one.',
        data: { requestId: event.context.requestId },
      })
    }

    if (decision.outcome === 'in-flight') {
      setResponseHeader(event, 'retry-after', RETRY_AFTER_SECONDS)
      throw createError({
        statusCode: 409,
        message:
          `A request with this ${IDEMPOTENCY_KEY_HEADER} is still in progress. ` +
          'Retry shortly to receive its response.',
        data: { requestId: event.context.requestId },
      })
    }

    if (decision.outcome === 'replay') {
      setResponseHeader(event, IDEMPOTENCY_REPLAY_HEADER, 'true')
      setResponseStatus(event, decision.response.status)
      // The one place a value crosses a JSON round trip. The cast is honest
      // about what it hides: the replayed value is the JSON projection of `T`,
      // so a `Date` comes back as the ISO string it was serialised to. Nitro
      // then serialises that string to exactly the same bytes the first caller
      // received, which is the property that actually matters and is what
      // `tests/unit/server/idempotent-route.test.ts` asserts.
      return (decision.response.body === null ? undefined : JSON.parse(decision.response.body)) as T
    }

    setResponseHeader(event, IDEMPOTENCY_REPLAY_HEADER, 'false')

    let value: T
    try {
      value = await handler(event)
    } catch (error) {
      // The handler did not produce a response worth replaying, so the claim is
      // dropped and the next attempt runs — see the "what is stored" note in
      // `idempotency.ts`. A release that fails is not worth failing the request
      // over: the claim times out on its own, and the caller is already getting
      // the handler's error.
      await release(store, key, claimToken)
      throw error
    }

    const status = getResponseStatus(event)

    if (!isReplayableStatus(status)) {
      await release(store, key, claimToken)
      return value
    }

    try {
      await completeIdempotency(store, {
        key,
        claimToken,
        fingerprint,
        response: captureResponse(status, value),
        settings: resolved,
        now: Date.now(),
      })
    } catch (error) {
      // The write already happened; there is nothing to undo and no reason to
      // turn a successful mutation into a 500. What it costs is stated in the
      // log line, because it is the one case where the client's guarantee
      // quietly does not hold: a retry of this key will execute again.
      console.error(
        `[idempotency] could not store the response for ${key}; a retry of this ` +
          'Idempotency-Key will re-execute the handler:',
        error,
      )
    }

    return value
  })
}

/** Best-effort claim release. A failure here is logged, never thrown. */
async function release(
  store: Storage<IdempotencyRecord>,
  key: string,
  claimToken: string,
): Promise<void> {
  try {
    await releaseIdempotencyClaim(store, key, claimToken)
  } catch (error) {
    console.error(
      `[idempotency] could not release the claim on ${key}; retries will get 409 ` +
        'until it times out:',
      error,
    )
  }
}
