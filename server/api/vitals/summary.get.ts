import type { VitalsSnapshot } from '~/server/utils/vitals-aggregate'
import { resolveVitalsSinkPlan } from '~/server/utils/vitals-sink'
import { useVitalsAggregate } from '~/server/utils/vitals-store'

export interface VitalsSummaryResponse extends VitalsSnapshot {
  /**
   * Whether a forwarding sink is configured. Without one, this snapshot is the
   * only copy of the data that exists — see `docs/web-vitals.md`.
   */
  readonly forwarding: boolean
  /** Which process answered, so a reader knows this is one instance's view. */
  readonly instance: { readonly uptimeSeconds: number }
}

/**
 * The instance's rolling Core Web Vitals summary: p75 per metric per route.
 *
 * **Authenticated**, by the default-deny rule in
 * `server/utils/access-policy.ts`. The ingest half is public because it must be;
 * this half is not, and it would be a poor trade to hand an anonymous caller a
 * route inventory with a traffic-weighted p75 next to each entry.
 *
 * ## Read it as one process's recent window
 *
 * `retained` is how many samples the percentile was computed over, `seen` is how
 * many arrived since boot, and the two differing means the window rolled. A
 * second instance has its own numbers, and a deploy resets both. That is stated
 * in the payload rather than in a comment nobody reading JSON will see: the
 * fields are named so the snapshot cannot be mistaken for a time series, and
 * `forwarding` says whether a real analytics backend has the durable copy.
 *
 * Not cached. A `defineCachedEventHandler` here would serve a summary that is
 * up to `maxAge` old *and* pinned to whichever instance rendered it, which is
 * the one property this endpoint must not have.
 */
export default defineEventHandler((event): VitalsSummaryResponse => {
  const plan = resolveVitalsSinkPlan(useRuntimeConfig(event), import.meta.dev)

  return {
    ...useVitalsAggregate().snapshot(),
    forwarding: plan.forwardUrl !== null,
    instance: { uptimeSeconds: Math.round(process.uptime()) },
  }
})
