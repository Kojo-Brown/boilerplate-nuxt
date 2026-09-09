import type { OutboxPublisher, OutboxRecord } from '~/server/utils/outbox'

/**
 * Where a claimed outbox row actually goes.
 *
 * Two publishers ship: an HTTP one that POSTs the event to a configured webhook,
 * and a logging one that `pnpm dev` uses so the machinery is observable without
 * a consumer to receive anything. `resolveOutboxRelayPlan` in
 * `server/utils/outbox.ts` decides which, and refuses to use the logging one in
 * a built server — see the note there.
 *
 * A third destination — a queue, a broker, an in-process handler table — is a
 * function of the same shape. The relay knows nothing about HTTP; it knows that
 * a publisher either resolves or throws.
 */

/** The JSON body a delivery carries. */
export interface OutboxEnvelope {
  /** The outbox row id. Stable across retries — this is the dedupe key. */
  readonly id: string
  readonly type: string
  readonly aggregate: { readonly type: string; readonly id: string }
  /** When the producing transaction committed, ISO 8601. */
  readonly occurredAt: string
  /** Which attempt this delivery is, 1-based. */
  readonly attempt: number
  readonly payload: Record<string, unknown>
}

/**
 * The header the row id travels in.
 *
 * The same header this app's own mutating routes read
 * (`server/utils/idempotency.ts`), because it is the same problem seen from the
 * other side: the relay is a client that retries, and a retry after a lost
 * response is exactly what makes at-least-once visible to a consumer. A consumer
 * built on this boilerplate can therefore put its ingest route behind
 * `defineIdempotentHandler` and be done.
 */
export const OUTBOX_IDEMPOTENCY_HEADER = 'idempotency-key'

/** Names the event in the headers, so a consumer can route without parsing. */
export const OUTBOX_EVENT_HEADER = 'x-outbox-event'

/** How much of a failing consumer's response body appears in the error. */
const MAX_RESPONSE_EXCERPT = 200

/** Builds the wire form of a record. */
export function toOutboxEnvelope(record: OutboxRecord): OutboxEnvelope {
  return {
    id: record.id,
    type: record.eventType,
    aggregate: { type: record.aggregateType, id: record.aggregateId },
    occurredAt: record.createdAt.toISOString(),
    attempt: record.attempts,
    payload: record.payload,
  }
}

export interface HttpOutboxPublisherOptions {
  readonly url: string
  readonly timeoutMs: number
  /** Injected so a test does not have to reach for the global. */
  readonly fetchImpl?: typeof globalThis.fetch
}

/**
 * POSTs each event to a webhook, and throws on anything but a 2xx.
 *
 * ## Why `fetch` and not `$fetch`
 *
 * `$fetch` — ofetch, which Nitro auto-imports and which the rest of this
 * codebase uses — retries idempotent requests on its own by default, and throws
 * a `FetchError` only after it has. That is the wrong layer for this. Retries
 * here belong to the relay, which counts them, spaces them out with jitter, and
 * gives up at `maxAttempts`; a second retry loop underneath would multiply the
 * attempt count invisibly and hold the row's lease open while it did.
 *
 * The platform `fetch` does exactly one request and reports what happened.
 *
 * ## What counts as delivered
 *
 * A 2xx, and nothing else. A 4xx is retried like a 5xx even though it usually
 * will not succeed, because the alternative — dropping an event because a
 * consumer answered 400 — loses data on a consumer bug. The attempt cap is what
 * ends it, and `failed_at` is where an operator finds it.
 *
 * The response body is drained and discarded on success. A response left
 * unconsumed keeps its socket out of the connection pool, which for a relay
 * publishing continuously is a slow leak of file descriptors.
 */
export function createHttpOutboxPublisher(options: HttpOutboxPublisherOptions): OutboxPublisher {
  const doFetch = options.fetchImpl ?? globalThis.fetch

  return async (record) => {
    const response = await doFetch(options.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [OUTBOX_IDEMPOTENCY_HEADER]: record.id,
        [OUTBOX_EVENT_HEADER]: record.eventType,
      },
      body: JSON.stringify(toOutboxEnvelope(record)),
      // `AbortSignal.timeout` rather than a `setTimeout` + `AbortController`
      // pair: the timer is owned by the platform and cleared when the request
      // settles, so a fast response does not leave a pending timer per event.
      signal: AbortSignal.timeout(options.timeoutMs),
    })

    if (!response.ok) {
      const excerpt = await readExcerpt(response)
      throw new Error(
        `Webhook responded ${response.status} ${response.statusText}` +
          (excerpt === '' ? '' : `: ${excerpt}`),
      )
    }

    // Drain, then discard. See the note above on connection reuse.
    await response.arrayBuffer().catch(() => undefined)
  }
}

/** Reads a failing response's body, best effort — never masks the status. */
async function readExcerpt(response: Response): Promise<string> {
  try {
    const text = await response.text()
    const flattened = text.replace(/\s+/g, ' ').trim()
    return flattened.length > MAX_RESPONSE_EXCERPT
      ? `${flattened.slice(0, MAX_RESPONSE_EXCERPT - 1)}…`
      : flattened
  } catch {
    return ''
  }
}

/**
 * Logs each event instead of delivering it. Development only.
 *
 * It exists so `pnpm dev` demonstrates the whole path — a transaction writes a
 * row, the relay claims it, something consumes it, the row is marked delivered —
 * against nothing but a database. `resolveOutboxRelayPlan` will not select it in
 * a built server, because a relay that marks rows delivered without delivering
 * them is a queue that reports itself drained while every consumer starves.
 *
 * The sink is a parameter rather than a `console` call: this module then has no
 * opinion about where logs go, and the plugin routes these lines through the
 * same `OutboxLogger` the relay's own warnings use.
 */
export function createLoggingOutboxPublisher(log: (message: string) => void): OutboxPublisher {
  return (record) => {
    log(`[outbox] ${record.eventType} ${record.aggregateType}/${record.aggregateId} (${record.id})`)
    return Promise.resolve()
  }
}
