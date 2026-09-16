import type { VitalsBatch } from '~/types/vitals'

/**
 * Where an accepted vitals batch goes.
 *
 * Three destinations ship, and which of them are active is a function of runtime
 * config and nothing else ({@link resolveVitalsSinkPlan}):
 *
 * - **`aggregate`** — the in-process rolling summary behind
 *   `GET /api/vitals/summary`. Always on. It is what makes a deployment with no
 *   analytics vendor honest rather than silently lossy; see
 *   `server/utils/vitals-aggregate.ts`.
 * - **`forward`** — POSTs the batch to `NUXT_VITALS_SINK_URL`. This is the real
 *   sink: an analytics collector, a log shipper, a Lambda in front of a
 *   warehouse. Off when the URL is unset.
 * - **`log`** — writes one line per batch. Development only, and only when no
 *   forwarding URL is set, so `pnpm dev` shows the path working end to end
 *   against nothing but the app itself.
 *
 * A fourth destination is a function of the same shape. Nothing here knows about
 * HTTP beyond the one sink that does.
 *
 * ## Why a failing sink does not fail the request
 *
 * The caller is `navigator.sendBeacon` on a page that is unloading. It ignores
 * the status code, it cannot retry, and by the time a response arrives the
 * document is usually gone. So a sink that throws is a logged warning and a 202,
 * not a 502: there is nobody to tell and nothing they could do. What must not
 * happen is the opposite — a failing sink taking down the route and, with it,
 * the aggregate that is still working.
 */

export interface VitalsSink {
  /** Appears in the ingest response, so a curl against the route shows the wiring. */
  readonly name: string
  readonly deliver: (batch: VitalsBatch) => Promise<void> | void
}

/** Outcome per sink. `error` is a message, never the thrown value. */
export interface VitalsDeliveryResult {
  readonly name: string
  readonly ok: boolean
  readonly error?: string
}

/** Default per-delivery timeout, in milliseconds. */
const DEFAULT_TIMEOUT_MS = 3000
const MIN_TIMEOUT_MS = 100
const MAX_TIMEOUT_MS = 30_000

/** How much of a failing sink's response body appears in the warning. */
const MAX_RESPONSE_EXCERPT = 200

/** The slice of `useRuntimeConfig()` this module reads. */
export interface VitalsRuntimeConfig {
  readonly vitals?: {
    readonly sinkUrl?: string
    /** From the environment this may arrive as a string — see `storage.ts`. */
    readonly timeoutMs?: number | string
  }
}

export interface VitalsSinkPlan {
  /** Absolute `http(s)` URL, or `null` when no forwarding sink is configured. */
  readonly forwardUrl: string | null
  readonly timeoutMs: number
  /** Whether the logging sink is active. Dev only, and only without a URL. */
  readonly logging: boolean
}

/**
 * Validates a configured sink URL, or throws with the reason.
 *
 * The message names the environment variable and does not echo the URL: a
 * collector endpoint routinely carries an API key in its path or query, and a
 * boot error goes to the logs. Same reasoning as `assertRedisUrl`.
 */
export function assertSinkUrl(url: string): void {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error('NUXT_VITALS_SINK_URL is not a URL. Expected https://host/path.')
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(
      `NUXT_VITALS_SINK_URL has protocol "${parsed.protocol}", which is not an HTTP scheme.`,
    )
  }
}

/** Clamps a timeout that may have arrived from the environment as a string. */
export function toTimeoutMs(value: number | string | undefined): number {
  const parsed = typeof value === 'string' ? Number(value) : value
  if (parsed === undefined || !Number.isFinite(parsed)) return DEFAULT_TIMEOUT_MS
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.floor(parsed)))
}

/**
 * Turns runtime config into the set of destinations a batch is delivered to.
 *
 * Throws on a URL that is set but unusable, which is the stance `storage.ts`
 * documents: unconfigured is a supported mode, misconfigured is not. A server
 * that booted with a typo'd collector address would look configured, forward
 * nothing, and be discovered weeks later when someone asked why the dashboard
 * was empty.
 */
export function resolveVitalsSinkPlan(config: VitalsRuntimeConfig, dev: boolean): VitalsSinkPlan {
  const url = config.vitals?.sinkUrl?.trim() ?? ''
  const timeoutMs = toTimeoutMs(config.vitals?.timeoutMs)

  if (url === '') return { forwardUrl: null, timeoutMs, logging: dev }

  assertSinkUrl(url)
  return { forwardUrl: url, timeoutMs, logging: false }
}

/**
 * The one line worth logging at boot, or `null` when there is nothing to say.
 *
 * Only a **built** server with no forwarding sink gets a message, and it is not
 * an error: that deployment still answers `/api/vitals/summary` from the
 * aggregate. What it does not have is history, or a view across instances, and
 * an operator who assumed otherwise should find that out at boot rather than
 * from a chart that resets on every deploy.
 */
export function vitalsBootWarning(plan: VitalsSinkPlan, dev: boolean): string | null {
  if (plan.forwardUrl !== null || dev) return null

  return (
    'Web Vitals: NUXT_VITALS_SINK_URL is unset, so reported metrics are kept only in ' +
    'this process and are visible at GET /api/vitals/summary. They are a rolling ' +
    'window, not history: a deploy discards them and a second instance keeps its own. ' +
    'See docs/web-vitals.md.'
  )
}

export interface HttpVitalsSinkOptions {
  readonly url: string
  readonly timeoutMs: number
  /** Injected so a test does not have to reach for the global. */
  readonly fetchImpl?: typeof globalThis.fetch
}

/**
 * POSTs the batch to the configured collector, and throws on anything but a 2xx.
 *
 * The platform `fetch`, not `$fetch`, for the reason `outbox-publisher.ts` gives
 * at length: ofetch retries idempotent requests by itself, and a retry loop
 * under a fire-and-forget delivery is invisible request amplification. Here
 * there is no relay above it either — a failed batch is *gone*, which is the
 * right trade for a metric whose successor arrives on the next page load, and
 * exactly the wrong one for the outbox's domain events.
 *
 * The batch is forwarded as received, with nothing added. No user agent, no
 * client IP, no session: a sink should get what the browser measured, and
 * enriching a third-party payload with request metadata is how an analytics
 * integration quietly becomes a data-sharing one.
 */
export function createHttpVitalsSink(options: HttpVitalsSinkOptions): VitalsSink {
  const doFetch = options.fetchImpl ?? globalThis.fetch

  return {
    name: 'forward',
    async deliver(batch) {
      const response = await doFetch(options.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(batch),
        // Platform-owned timer, cleared when the request settles — see the note
        // in `outbox-publisher.ts`.
        signal: AbortSignal.timeout(options.timeoutMs),
      })

      if (!response.ok) {
        const excerpt = await readExcerpt(response)
        throw new Error(
          `Vitals sink responded ${response.status} ${response.statusText}` +
            (excerpt === '' ? '' : `: ${excerpt}`),
        )
      }

      // Drain, then discard: an unconsumed response keeps its socket out of the
      // pool, which on a route this hot is a steady leak of file descriptors.
      await response.arrayBuffer().catch(() => undefined)
    },
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
 * Logs one line per batch instead of delivering it. Development only.
 *
 * Unlike the outbox's logging publisher, this one is not a lie in production —
 * it is simply not selected there, because the aggregate already gives a built
 * server somewhere real for the data to land.
 */
export function createLoggingVitalsSink(log: (message: string) => void): VitalsSink {
  return {
    name: 'log',
    deliver(batch) {
      const summary = batch.samples.map((s) => `${s.name}=${s.value}(${s.rating})`).join(' ')
      log(`[vitals] ${batch.samples[0]?.route ?? '-'} visit=${batch.page.visitId} ${summary}`)
    },
  }
}

/**
 * Delivers a batch to every sink and reports what happened, without throwing.
 *
 * Sequential rather than `Promise.all`: the sinks are one HTTP call and two
 * in-memory writes, so there is nothing to win by racing them, and a sequential
 * pass keeps the result array in a stable, sink-ordered shape for the response
 * and the tests.
 */
export async function deliverVitals(
  batch: VitalsBatch,
  sinks: readonly VitalsSink[],
): Promise<VitalsDeliveryResult[]> {
  const results: VitalsDeliveryResult[] = []

  for (const sink of sinks) {
    try {
      await sink.deliver(batch)
      results.push({ name: sink.name, ok: true })
    } catch (error) {
      results.push({
        name: sink.name,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  return results
}

/**
 * A logger that passes at most one message through per interval, and says how
 * many it swallowed when it next lets one through.
 *
 * `/api/vitals` is public, unauthenticated and called by every visitor, so a
 * collector that starts refusing requests would otherwise write one warning per
 * beacon — turning a broken dashboard into a broken log pipeline, and handing
 * anyone on the internet a way to fill the logs by posting batches. Throttling
 * makes the failure visible at a fixed rate instead.
 *
 * `now` is injected so the behaviour is testable without timers.
 */
export function createThrottledLogger(
  log: (message: string) => void,
  intervalMs: number,
  now: () => number = Date.now,
): (message: string) => void {
  let lastAt = Number.NEGATIVE_INFINITY
  let suppressed = 0

  return (message) => {
    const at = now()
    if (at - lastAt < intervalMs) {
      suppressed++
      return
    }

    lastAt = at
    const note = suppressed > 0 ? ` (${suppressed} similar suppressed)` : ''
    suppressed = 0
    log(`${message}${note}`)
  }
}
