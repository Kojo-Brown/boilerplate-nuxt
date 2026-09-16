import { createVitalsAggregate, type VitalsAggregate } from '~/server/utils/vitals-aggregate'
import {
  createHttpVitalsSink,
  createLoggingVitalsSink,
  createThrottledLogger,
  type VitalsSink,
  type VitalsSinkPlan,
} from '~/server/utils/vitals-sink'

/**
 * The process-scoped pieces of vitals ingest: the rolling aggregate, and the
 * throttled warning channel a failing forward sink writes to.
 *
 * Both are module state, which in Nitro means *process* state shared by every
 * request — the thing `docs/composable-design-rules.md` forbids in `composables/`
 * and `utils/`. It is correct here and the distinction is the point: those rules
 * exist because a value on the app layers would be shared between two users'
 * SSR renders. Nothing below is per-request or per-user. The aggregate is
 * explicitly an instance-wide summary, and a rate limit that reset per request
 * would not be one.
 *
 * Created lazily rather than at import: a build that imports this module while
 * prerendering has no reason to allocate a window it will never write to.
 */

/** How often a failing sink may write a warning, in milliseconds. */
const WARN_INTERVAL_MS = 60_000

let aggregate: VitalsAggregate | undefined
let warn: ((message: string) => void) | undefined

/** The instance's rolling summary, behind `GET /api/vitals/summary`. */
export function useVitalsAggregate(): VitalsAggregate {
  aggregate ??= createVitalsAggregate()
  return aggregate
}

/**
 * Warns about a sink failure, at most once a minute per process.
 *
 * `console.warn` rather than a logger abstraction, matching the rest of
 * `server/`: Nitro's console output is what a platform collects.
 */
export function warnVitals(message: string): void {
  warn ??= createThrottledLogger((line) => console.warn(line), WARN_INTERVAL_MS)
  warn(message)
}

/** Writes each sample into the rolling summary. Always present. */
export function createAggregateVitalsSink(
  target: VitalsAggregate = useVitalsAggregate(),
): VitalsSink {
  return {
    name: 'aggregate',
    deliver(batch) {
      for (const sample of batch.samples) target.record(sample)
    },
  }
}

/**
 * The sinks a plan resolves to, in delivery order.
 *
 * The aggregate goes first, so a forwarding sink that is timing out cannot delay
 * the write that `GET /api/vitals/summary` reads — {@link deliverVitals} awaits
 * them in sequence.
 */
export function vitalsSinksFor(plan: VitalsSinkPlan): VitalsSink[] {
  const sinks: VitalsSink[] = [createAggregateVitalsSink()]

  if (plan.forwardUrl !== null) {
    sinks.push(createHttpVitalsSink({ url: plan.forwardUrl, timeoutMs: plan.timeoutMs }))
  } else if (plan.logging) {
    sinks.push(createLoggingVitalsSink((message) => console.warn(message)))
  }

  return sinks
}
