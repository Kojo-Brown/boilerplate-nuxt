/**
 * The transactional outbox: the record shape, the retry rules, and the relay
 * loop that drains it.
 *
 * ## The problem this exists for
 *
 * `POST /api/todos` writes a row and then wants to tell something else — a
 * search indexer, a webhook, an email worker. Two systems, one handler, and no
 * transaction spans both:
 *
 * ```ts
 * await db.insert(todos).values({ title })   // committed
 * await fetch(webhook, { … })                // …and this throws
 * ```
 *
 * The todo exists and nobody was told. Swapping the order is not a fix, it is
 * the opposite bug: the webhook fires for a todo the database never kept. There
 * is no ordering of a commit and a network call that makes them atomic, and a
 * retry loop around the second one only narrows the window — the process can
 * still be killed between them.
 *
 * `server/utils/idempotency.ts` says as much in its own docs: *"a handler that
 * throws after committing a side effect will commit it twice on a retry, and no
 * idempotency layer that only sees the throw can prevent that. The fix for those
 * handlers is a transaction."* This is that fix.
 *
 * The outbox turns the two writes into one. The event is a **row in the same
 * database**, written in the same transaction as the change it describes, so the
 * commit is what makes both true at once:
 *
 * ```ts
 * await db.transaction(async (tx) => {
 *   const [todo] = await tx.insert(todos).values({ title }).returning()
 *   await enqueueOutbox(tx, [todoCreatedMessage(todo)])
 * })
 * ```
 *
 * A separate loop — {@link createOutboxRelay}, started by
 * `server/plugins/outbox-relay.ts` — reads those rows afterwards and publishes
 * them. The handler's job ends at the commit, and the network call it used to
 * make is now something that can be retried for as long as it takes without the
 * client waiting on it.
 *
 * ## At-least-once, and why that is the honest ceiling
 *
 * The relay publishes, then marks the row delivered. Those are two systems
 * again, and the same argument applies: a process that dies between them
 * republishes on the next pass. So delivery is **at least once**, never exactly
 * once, and this module does not pretend otherwise anywhere.
 *
 * What it does instead is make the duplicate cheap to absorb. Every delivery
 * carries the outbox row's id — `server/utils/outbox-publisher.ts` sends it as
 * an `Idempotency-Key`, the same header this app's own mutating routes accept —
 * so a consumer that deduplicates on it sees one event. Exactly-once is a
 * property of the *pair*, and the id is this half of it.
 *
 * ## Ordering
 *
 * A batch is claimed in `available_at, created_at` order and published
 * sequentially, so an idle queue delivers in commit order. Under retries it does
 * not: a failed event is rescheduled behind events that committed after it. That
 * is the trade — an outbox that preserved order under failure would have to stop
 * the queue on the first failure, and one unreachable consumer would then hold
 * up every other event in the table.
 *
 * Consumers that need per-aggregate order get it from the payload, which carries
 * the row's own `updatedAt`, not from arrival order.
 *
 * ## Concurrency between relays
 *
 * Every server instance runs a relay, and they compete for the same table. The
 * claim is one statement — `UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP
 * LOCKED)`, in `server/utils/outbox-store.ts` — so two relays never take the
 * same row, and a slow one is stepped around rather than waited for. The claim
 * also pushes `available_at` out by {@link OutboxSettings.claimLeaseMs}, which
 * is what releases a row held by a relay that died mid-publish: the lease
 * expires and the next poll picks it up. No separate reaper, no locks held
 * across a network call.
 *
 * ## Attempts count claims, not failures
 *
 * `attempts` is incremented by the claim, before the publish is tried. A publish
 * that kills the process therefore still costs an attempt, so a payload that
 * reliably crashes the relay dead-letters after {@link OutboxSettings.maxAttempts}
 * instead of being retried forever by every instance in turn. The cost is that a
 * relay restarted mid-batch spends attempts on rows it never actually published;
 * with the default of 10, that is a queue that tolerates nine crashes.
 */

/** A message a handler enqueues. The relay adds everything else. */
export interface OutboxMessage {
  /** The kind of thing that changed — `todo`. */
  readonly aggregateType: string
  /** The id of the row that changed. */
  readonly aggregateId: string
  /** Past tense, `<aggregate>.<verb>` — `todo.created`. */
  readonly eventType: string
  /** The event body, frozen at write time. Must be JSON-serialisable. */
  readonly payload: Record<string, unknown>
}

/** A claimed row, as the relay and a publisher see it. */
export interface OutboxRecord extends OutboxMessage {
  /** The row id. Also the delivery's `Idempotency-Key` — see the doc above. */
  readonly id: string
  /** Which attempt this is, 1-based, counting the one in progress. */
  readonly attempts: number
  /** When the transaction that produced this event committed. */
  readonly createdAt: Date
}

/**
 * What the relay needs from the database, and nothing else.
 *
 * Four methods rather than a `Database`, so the loop below is tested against an
 * in-memory implementation that can be made to fail on demand — a publisher that
 * throws, a store that throws, a row on its last attempt — none of which is
 * reachable through a real Postgres without arranging an outage.
 * `server/utils/outbox-store.ts` has the Drizzle one.
 */
export interface OutboxStore {
  /**
   * Takes up to `limit` rows that are due, marks them in flight for `leaseMs`,
   * and returns them. Must be safe to call concurrently from several processes.
   */
  readonly claim: (input: {
    readonly limit: number
    readonly now: Date
    readonly leaseMs: number
  }) => Promise<readonly OutboxRecord[]>
  /** Records a delivery. The row stays as the audit trail. */
  readonly markPublished: (input: { readonly id: string; readonly now: Date }) => Promise<void>
  /** Puts a failed row back on the queue at `availableAt`. */
  readonly reschedule: (input: {
    readonly id: string
    readonly availableAt: Date
    readonly lastError: string
  }) => Promise<void>
  /** Gives up on a row: sets `failed_at` so no poll will claim it again. */
  readonly deadLetter: (input: {
    readonly id: string
    readonly now: Date
    readonly lastError: string
  }) => Promise<void>
}

/**
 * Delivers one record, or throws.
 *
 * Throwing is how a publisher says "retry me"; returning is a promise that the
 * consumer has it. There is no third outcome on purpose — a publisher that
 * wanted to say "drop this, it will never work" would be making a retention
 * decision that belongs to the operator reading `failed_at`.
 */
export type OutboxPublisher = (record: OutboxRecord) => Promise<void>

/** Severity of a relay log line. */
export type OutboxLogLevel = 'warn' | 'error'

/** Where the relay's log lines go. Injected so a test can read them. */
export type OutboxLogger = (level: OutboxLogLevel, message: string, error?: unknown) => void

/** How long the relay waits between polls when the queue was empty. */
export const DEFAULT_POLL_INTERVAL_MS = 1_000
/** Poll-interval bounds. The floor is what stops a busy loop on the database. */
export const MIN_POLL_INTERVAL_MS = 50
export const MAX_POLL_INTERVAL_MS = 60_000

/** How many rows one claim takes. */
export const DEFAULT_BATCH_SIZE = 20
export const MIN_BATCH_SIZE = 1
/**
 * Batch ceiling. A batch is published sequentially and holds its lease for the
 * whole pass, so a large one is a long time before any row is retryable.
 */
export const MAX_BATCH_SIZE = 500

/** First retry delay; doubled per attempt from there. */
export const DEFAULT_BASE_BACKOFF_MS = 1_000
export const MIN_BASE_BACKOFF_MS = 100
export const MAX_BASE_BACKOFF_MS = 60_000

/** Ceiling on the retry delay — five minutes. */
export const DEFAULT_MAX_BACKOFF_MS = 5 * 60_000
export const MIN_MAX_BACKOFF_MS = 1_000
export const MAX_MAX_BACKOFF_MS = 60 * 60_000

/**
 * Attempts before a row is dead-lettered.
 *
 * Ten attempts at the default backoff is roughly forty minutes of trying, which
 * outlasts an ordinary deploy or restart of a consumer and does not outlast an
 * operator's patience with a poison payload.
 */
export const DEFAULT_MAX_ATTEMPTS = 10
export const MIN_MAX_ATTEMPTS = 1
export const MAX_MAX_ATTEMPTS = 50

/**
 * How long a claim holds a row.
 *
 * It has to be longer than a publish can take, or a second relay claims a row
 * the first one is still delivering and the consumer sees the duplicate for no
 * reason. The default is six times `publishTimeoutMs`.
 */
export const DEFAULT_CLAIM_LEASE_MS = 30_000
export const MIN_CLAIM_LEASE_MS = 1_000
export const MAX_CLAIM_LEASE_MS = 10 * 60_000

/** How long one delivery may take before it counts as failed. */
export const DEFAULT_PUBLISH_TIMEOUT_MS = 5_000
export const MIN_PUBLISH_TIMEOUT_MS = 100
export const MAX_PUBLISH_TIMEOUT_MS = 60_000

/**
 * How much of a failure's message is kept in `last_error`.
 *
 * Enough for the line that names the cause; not so much that a consumer echoing
 * a stack trace into its response body writes kilobytes per attempt into a row
 * that is retried ten times.
 */
export const MAX_LAST_ERROR_LENGTH = 500

/** The relay's tuning, resolved and clamped. */
export interface OutboxSettings {
  readonly pollIntervalMs: number
  readonly batchSize: number
  readonly baseBackoffMs: number
  readonly maxBackoffMs: number
  readonly maxAttempts: number
  readonly claimLeaseMs: number
  readonly publishTimeoutMs: number
}

/**
 * The subset of `useRuntimeConfig()` this module reads, declared structurally so
 * a test passes a literal instead of a whole Nuxt config.
 *
 * Every number is `number | string` for the reason `server/utils/storage.ts`
 * gives: a value overridden by a `NUXT_*` environment variable arrives as a
 * string unless Nuxt's coercion recognises the default's type, and a
 * `pollIntervalMs` that stayed `"1000"` would be handed to `setTimeout` as
 * `NaN` milliseconds — which fires immediately, forever.
 */
export interface OutboxRuntimeConfig {
  readonly databaseUrl?: string
  readonly outbox?: {
    readonly webhookUrl?: string
    readonly relay?: {
      readonly enabled?: boolean | string
      readonly pollIntervalMs?: number | string
      readonly batchSize?: number | string
      readonly baseBackoffMs?: number | string
      readonly maxBackoffMs?: number | string
      readonly maxAttempts?: number | string
      readonly claimLeaseMs?: number | string
      readonly publishTimeoutMs?: number | string
    }
  }
}

/**
 * Coerces a runtime-config integer that may have arrived from the environment as
 * a string, and clamps it into `[min, max]`.
 *
 * Anything unusable — `"abc"`, an infinity — falls back rather than clamping,
 * because `Math.max(min, NaN)` is `NaN` and a silent `NaN` here is the failure
 * mode this function exists to prevent.
 *
 * An **empty** string falls back too, and that case is its own line rather than
 * a consequence of the parse: `Number("")` is `0`, not `NaN`, so
 * `NUXT_OUTBOX_RELAY_POLL_INTERVAL_MS=` — a variable set to nothing, which is
 * what a `.env` line with no value and an unset shell variable both produce —
 * would otherwise clamp to the floor and poll twenty times a second.
 */
export function toClampedInt(
  value: number | string | undefined,
  bounds: { readonly fallback: number; readonly min: number; readonly max: number },
): number {
  if (typeof value === 'string' && value.trim() === '') return bounds.fallback
  const parsed = typeof value === 'string' ? Number(value.trim()) : value
  if (parsed === undefined || !Number.isFinite(parsed)) return bounds.fallback
  return Math.min(bounds.max, Math.max(bounds.min, Math.floor(parsed)))
}

/**
 * Coerces a runtime-config flag that may have arrived as a string.
 *
 * Only the four spellings an operator actually types are recognised. Anything
 * else falls back instead of being truthy, so `NUXT_OUTBOX_RELAY_ENABLED=no`
 * cannot silently mean "yes" — which is what `Boolean("no")` gives.
 */
export function toBoolean(value: boolean | string | undefined, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value
  if (value === undefined) return fallback
  const normalised = value.trim().toLowerCase()
  if (normalised === 'true' || normalised === '1') return true
  if (normalised === 'false' || normalised === '0') return false
  return fallback
}

/** Reads the relay's tuning out of runtime config, clamped. */
export function resolveOutboxSettings(config: OutboxRuntimeConfig): OutboxSettings {
  const relay = config.outbox?.relay
  const baseBackoffMs = toClampedInt(relay?.baseBackoffMs, {
    fallback: DEFAULT_BASE_BACKOFF_MS,
    min: MIN_BASE_BACKOFF_MS,
    max: MAX_BASE_BACKOFF_MS,
  })

  return {
    pollIntervalMs: toClampedInt(relay?.pollIntervalMs, {
      fallback: DEFAULT_POLL_INTERVAL_MS,
      min: MIN_POLL_INTERVAL_MS,
      max: MAX_POLL_INTERVAL_MS,
    }),
    batchSize: toClampedInt(relay?.batchSize, {
      fallback: DEFAULT_BATCH_SIZE,
      min: MIN_BATCH_SIZE,
      max: MAX_BATCH_SIZE,
    }),
    baseBackoffMs,
    // Floored at the base delay as well as at its own minimum: a configured
    // ceiling below the first delay would make every retry wait the ceiling,
    // turning the backoff into a fixed interval without saying so.
    maxBackoffMs: Math.max(
      baseBackoffMs,
      toClampedInt(relay?.maxBackoffMs, {
        fallback: DEFAULT_MAX_BACKOFF_MS,
        min: MIN_MAX_BACKOFF_MS,
        max: MAX_MAX_BACKOFF_MS,
      }),
    ),
    maxAttempts: toClampedInt(relay?.maxAttempts, {
      fallback: DEFAULT_MAX_ATTEMPTS,
      min: MIN_MAX_ATTEMPTS,
      max: MAX_MAX_ATTEMPTS,
    }),
    claimLeaseMs: toClampedInt(relay?.claimLeaseMs, {
      fallback: DEFAULT_CLAIM_LEASE_MS,
      min: MIN_CLAIM_LEASE_MS,
      max: MAX_CLAIM_LEASE_MS,
    }),
    publishTimeoutMs: toClampedInt(relay?.publishTimeoutMs, {
      fallback: DEFAULT_PUBLISH_TIMEOUT_MS,
      min: MIN_PUBLISH_TIMEOUT_MS,
      max: MAX_PUBLISH_TIMEOUT_MS,
    }),
  }
}

/**
 * How long to wait before attempt `attempts + 1`, with jitter.
 *
 * The exponential part is `base × 2^(attempts − 1)`, capped at `maxBackoffMs`.
 * The jitter is the reason this takes a `random`: every relay in a deployment
 * fails at the same instant when a consumer goes down, so an undithered backoff
 * marches them all to the same retry instant and the consumer's first moment
 * back up is a thundering herd of the whole fleet.
 *
 * The jitter is applied to the *upper half* of the window — the delay is
 * uniform over `[exp/2, exp]` — rather than over `[0, exp]` as "full jitter"
 * would have it. Full jitter's short draws are the problem here: they are
 * indistinguishable from no backoff at all, and with a batch of twenty rows all
 * failing against the same dead consumer, a handful of near-zero delays per pass
 * is a hot loop against a service that is already down.
 */
export function backoffDelayMs(
  attempts: number,
  settings: OutboxSettings,
  random: () => number = Math.random,
): number {
  const exponent = Math.max(0, attempts - 1)
  // `2 ** exponent` overflows to Infinity around attempt 1075; `Math.min` with
  // the cap handles that, but the multiplication is clamped first so the
  // intermediate stays finite for any attempt count the cap would swallow anyway.
  const uncapped = settings.baseBackoffMs * 2 ** Math.min(exponent, 32)
  const window = Math.min(settings.maxBackoffMs, uncapped)
  return Math.round(window / 2 + random() * (window / 2))
}

/**
 * Renders a thrown value into the one line `last_error` keeps.
 *
 * Truncated to {@link MAX_LAST_ERROR_LENGTH} and stripped of newlines, so a row
 * holds the message rather than a consumer's stack trace, and a log line built
 * from it stays one line.
 */
export function describeOutboxError(error: unknown): string {
  const raw =
    error instanceof Error
      ? `${error.name}: ${error.message}`
      : typeof error === 'string'
        ? error
        : (() => {
            try {
              return JSON.stringify(error) ?? String(error)
            } catch {
              return String(error)
            }
          })()

  const flattened = raw.replace(/\s+/g, ' ').trim()
  return flattened.length > MAX_LAST_ERROR_LENGTH
    ? `${flattened.slice(0, MAX_LAST_ERROR_LENGTH - 1)}…`
    : flattened
}

/** What one pass of the relay did. */
export interface RelayOutcome {
  /** Rows this pass took. A full batch means there is probably more waiting. */
  readonly claimed: number
  readonly published: number
  /** Failed, and scheduled for another attempt. */
  readonly retried: number
  /** Failed on their last attempt; `failed_at` is now set. */
  readonly deadLettered: number
}

/** Everything {@link relayBatch} and {@link createOutboxRelay} depend on. */
export interface OutboxRelayDeps {
  readonly store: OutboxStore
  readonly publish: OutboxPublisher
  readonly settings: OutboxSettings
  /** Injected so a test can pin the schedule it asserts. */
  readonly now?: () => Date
  /** Injected so a test can pin the jitter. */
  readonly random?: () => number
  readonly log?: OutboxLogger
}

/**
 * Claims one batch, publishes it, and records what happened to each row.
 *
 * Publishing is sequential — see the ordering note at the top of this file, and
 * because twenty parallel requests to a consumer that is already struggling is
 * not the behaviour to ship by default.
 *
 * A throw from the **store** is not caught here. That is the difference between
 * "the consumer is down", which is this function's business and produces a
 * reschedule, and "the database is down", which is not: there is nothing to
 * write the failure to. It propagates to the loop, which logs it and waits a
 * poll interval. Rows already claimed in that pass are not lost — their lease
 * expires and the next poll takes them again.
 */
export async function relayBatch(deps: OutboxRelayDeps): Promise<RelayOutcome> {
  const { publish, settings } = deps
  // Guarded here rather than by the caller, so the distinction holds for a
  // direct call as well as for one through the loop. Wrapping a store that is
  // already guarded is harmless — the marker survives.
  const store = guardStore(deps.store)
  const now = deps.now ?? (() => new Date())
  const random = deps.random ?? Math.random
  const log = deps.log ?? (() => {})

  const claimed = await store.claim({
    limit: settings.batchSize,
    now: now(),
    leaseMs: settings.claimLeaseMs,
  })

  let published = 0
  let retried = 0
  let deadLettered = 0

  for (const record of claimed) {
    try {
      await publish(record)
      await store.markPublished({ id: record.id, now: now() })
      published += 1
      continue
    } catch (error) {
      // Only a publish failure reaches the rest of this block; a store failure
      // in `markPublished` would land here too, so it is re-thrown rather than
      // recorded as a delivery failure the store cannot record either.
      if (isStoreFailure(error)) throw error

      const lastError = describeOutboxError(error)

      if (record.attempts >= settings.maxAttempts) {
        await store.deadLetter({ id: record.id, now: now(), lastError })
        deadLettered += 1
        log(
          'error',
          `[outbox] ${record.eventType} ${record.id} failed on attempt ` +
            `${record.attempts} of ${settings.maxAttempts} and was dead-lettered: ${lastError}`,
        )
        continue
      }

      const delay = backoffDelayMs(record.attempts, settings, random)
      await store.reschedule({
        id: record.id,
        availableAt: new Date(now().getTime() + delay),
        lastError,
      })
      retried += 1
      log(
        'warn',
        `[outbox] ${record.eventType} ${record.id} failed on attempt ` +
          `${record.attempts}, retrying in ${delay}ms: ${lastError}`,
      )
    }
  }

  return { claimed: claimed.length, published, retried, deadLettered }
}

/**
 * Marks an error as the store's rather than the publisher's.
 *
 * `relayBatch` catches around both the publish and the `markPublished` that
 * follows it, because they are one unit of work — and that means a store outage
 * would otherwise be recorded as "this event failed to publish" by the very
 * store that just failed. Wrapping is how the two are told apart without a
 * second try/catch nesting around each call.
 */
class OutboxStoreFailure extends Error {
  constructor(cause: unknown) {
    super('Outbox store write failed', { cause })
    this.name = 'OutboxStoreFailure'
  }
}

function isStoreFailure(error: unknown): boolean {
  return error instanceof OutboxStoreFailure
}

/**
 * A running relay. `start` is synchronous; the loop it kicks off is not.
 */
export interface OutboxRelay {
  /** Begins polling. Calling it twice is a no-op, not a second loop. */
  readonly start: () => void
  /** Stops polling and waits for the pass in flight. Safe to call twice. */
  readonly stop: () => Promise<void>
  /** One pass, for a test or a manual drain. Runs whether or not `start` did. */
  readonly runOnce: () => Promise<RelayOutcome>
}

/**
 * The poll loop.
 *
 * Three properties worth stating, because each is a bug in the obvious version:
 *
 *  - **No overlap.** It is a `setTimeout` chain, not `setInterval`: the next
 *    poll is scheduled after the previous one finishes. An interval whose period
 *    is shorter than a pass — which is every interval, once a consumer starts
 *    timing out — would stack passes until the batches met each other.
 *  - **Drains without waiting.** A pass that filled its batch polls again
 *    immediately, because a full batch means rows were left behind. Only an
 *    under-full pass sleeps, so a backlog drains at the speed of the consumer
 *    rather than at `batchSize` per `pollIntervalMs`.
 *  - **Shuts down at once.** The sleep between polls is cancellable, so `stop`
 *    does not wait out a poll interval it is in the middle of. The timer is also
 *    `unref`ed, so a relay that is somehow never stopped cannot be the reason a
 *    process refuses to exit.
 */
export function createOutboxRelay(deps: OutboxRelayDeps): OutboxRelay {
  const log = deps.log ?? (() => {})
  const guarded: OutboxRelayDeps = { ...deps, log }

  let running = false
  let loop: Promise<void> | undefined
  let wake: (() => void) | undefined

  function idle(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        wake = undefined
        resolve()
      }, ms)
      unrefTimer(timer)
      // Only the cancelling path clears the timer; the timer's own callback has
      // nothing left to clear.
      wake = () => {
        clearTimeout(timer)
        wake = undefined
        resolve()
      }
    })
  }

  async function pump(): Promise<void> {
    while (running) {
      try {
        const outcome = await relayBatch(guarded)
        if (!running) return
        if (outcome.claimed >= guarded.settings.batchSize) continue
      } catch (error) {
        log('error', '[outbox] relay pass failed; retrying after the poll interval', error)
        if (!running) return
      }
      await idle(guarded.settings.pollIntervalMs)
    }
  }

  return {
    start() {
      if (running) return
      running = true
      // Not awaited: `defineNitroPlugin` must return so the server can start
      // serving. `pump` handles its own errors, so this cannot reject — the
      // `catch` is there for the one case that would be a bug in `pump` itself,
      // where an unhandled rejection would otherwise take the process down.
      loop = pump().catch((error: unknown) => {
        log('error', '[outbox] relay loop stopped unexpectedly', error)
      })
    },
    async stop() {
      running = false
      wake?.()
      await loop
      loop = undefined
    },
    runOnce() {
      return relayBatch(guarded)
    },
  }
}

/**
 * Wraps a store so its failures are distinguishable from a publisher's.
 *
 * See {@link OutboxStoreFailure}. Applied once at the top of `relayBatch`
 * rather than at each call site inside it.
 */
function guardStore(store: OutboxStore): OutboxStore {
  return {
    claim: (input) => store.claim(input).catch(rethrowAsStoreFailure),
    markPublished: (input) => store.markPublished(input).catch(rethrowAsStoreFailure),
    reschedule: (input) => store.reschedule(input).catch(rethrowAsStoreFailure),
    deadLetter: (input) => store.deadLetter(input).catch(rethrowAsStoreFailure),
  }
}

function rethrowAsStoreFailure(error: unknown): never {
  throw new OutboxStoreFailure(error)
}

/**
 * `unref`s a timer when the runtime has the method.
 *
 * Node's `setTimeout` returns a `Timeout`; the DOM's returns a number, and a
 * built Nitro server can be typed either way depending on the preset. The check
 * is what lets this module compile and behave under both.
 */
function unrefTimer(timer: unknown): void {
  if (typeof timer !== 'object' || timer === null || !('unref' in timer)) return
  const { unref } = timer as { unref?: () => void }
  if (typeof unref === 'function') unref.call(timer)
}

/** How the relay was configured to deliver, decided once at boot. */
export type OutboxRelayMode =
  /** POST each event to `NUXT_OUTBOX_WEBHOOK_URL`. */
  | 'http'
  /** Log each event instead of delivering it. Development only. */
  | 'log'
  /** Do not poll at all. */
  | 'disabled'

/** Why the relay is not running, when it is not. */
export type OutboxDisabledReason =
  /** `NUXT_OUTBOX_RELAY_ENABLED=false`. */
  | 'turned-off'
  /** No `NUXT_DATABASE_URL`, so there is no table to poll. */
  | 'no-database'
  /** A built server with no destination configured. */
  | 'no-destination'

/** The boot decision: whether to run, and where to deliver. */
export type OutboxRelayPlan =
  | { readonly mode: 'http'; readonly url: string; readonly settings: OutboxSettings }
  | { readonly mode: 'log'; readonly settings: OutboxSettings }
  | {
      readonly mode: 'disabled'
      readonly reason: OutboxDisabledReason
      readonly settings: OutboxSettings
    }

/** Schemes a webhook URL may use. */
const WEBHOOK_PROTOCOLS = new Set(['http:', 'https:'])

/**
 * Validates a configured webhook URL, or throws with the reason.
 *
 * The message names the environment variable and the scheme rather than echoing
 * the URL: a webhook URL routinely carries a token in its path or query, and a
 * boot error goes to the logs. Same rule as `assertRedisUrl`.
 */
export function assertWebhookUrl(url: string): void {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error('NUXT_OUTBOX_WEBHOOK_URL is not a URL. Expected https://host/path.')
  }

  if (!WEBHOOK_PROTOCOLS.has(parsed.protocol)) {
    throw new Error(
      `NUXT_OUTBOX_WEBHOOK_URL has protocol "${parsed.protocol}", which is not HTTP. ` +
        'Expected http:// or https://.',
    )
  }
}

/**
 * Turns runtime config into the boot decision.
 *
 * The one case that needs explaining is a **development** server with no
 * webhook: it gets `log` mode, so `pnpm dev` shows the outbox working —
 * enqueue, claim, deliver, mark — without anything to receive the events. A
 * built server does not, because "log it and mark it delivered" is not delivery
 * and a production deployment that silently did that would report a drained
 * queue while nothing downstream had heard anything.
 *
 * Throws on a webhook URL that is set but unusable, for the reason
 * `server/utils/storage.ts` gives about `NUXT_REDIS_URL`: it means someone
 * intended delivery and will not get it.
 */
export function resolveOutboxRelayPlan(config: OutboxRuntimeConfig, dev: boolean): OutboxRelayPlan {
  const settings = resolveOutboxSettings(config)

  if (!toBoolean(config.outbox?.relay?.enabled, true)) {
    return { mode: 'disabled', reason: 'turned-off', settings }
  }

  // Checked before the destination: with no database there is no outbox table,
  // so a misconfigured webhook is not the thing to fail the boot on.
  if ((config.databaseUrl ?? '').trim() === '') {
    return { mode: 'disabled', reason: 'no-database', settings }
  }

  const url = config.outbox?.webhookUrl?.trim() ?? ''

  if (url !== '') {
    assertWebhookUrl(url)
    return { mode: 'http', url, settings }
  }

  return dev ? { mode: 'log', settings } : { mode: 'disabled', reason: 'no-destination', settings }
}

/**
 * The one line worth logging at boot, or `null` when there is nothing to say.
 *
 * Success is silent, and so is every case an operator chose. The only message is
 * the one they did not: a built server that will write outbox rows and never
 * deliver them, which looks like nothing at all until a consumer notices it is
 * missing events.
 */
export function outboxBootWarning(plan: OutboxRelayPlan, dev: boolean): string | null {
  if (dev || plan.mode !== 'disabled' || plan.reason !== 'no-destination') return null

  return (
    'Outbox relay: not running because NUXT_OUTBOX_WEBHOOK_URL is unset. Mutating ' +
    'routes still write outbox rows inside their transaction, so nothing is lost — ' +
    'but nothing is delivered either, and the table will grow. Set the webhook, or ' +
    'set NUXT_OUTBOX_RELAY_ENABLED=false to say the omission is deliberate. See ' +
    'docs/outbox.md.'
  )
}
