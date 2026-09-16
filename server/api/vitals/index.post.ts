import { parseVitalsBatch } from '~/server/utils/vitals-schemas'
import { deliverVitals, resolveVitalsSinkPlan } from '~/server/utils/vitals-sink'
import { vitalsSinksFor, warnVitals } from '~/server/utils/vitals-store'
import type { VitalsIngestResult } from '~/types/vitals'

/**
 * Ingest for the Core Web Vitals beacons `plugins/web-vitals.client.ts` sends.
 *
 * Public by policy (`server/utils/access-policy.ts`) and it cannot be otherwise:
 * the metrics that matter most come from first-time, logged-out visitors, and
 * `navigator.sendBeacon` cannot attach an `Authorization` header even when there
 * is a session. Everything that makes that safe is in
 * `server/utils/vitals-schemas.ts` — closed enums, bounded strings and arrays,
 * `.strict()` objects — so an unauthenticated body cannot become unbounded
 * memory here or arbitrary JSON at a third-party sink.
 *
 * ## 202, always, once the body parses
 *
 * The caller is a page that is unloading. It never reads this response: a beacon
 * reports "queued", not "delivered", and the document is usually gone before the
 * status line arrives. So a sink that is down is a throttled warning and a 202 —
 * there is nobody to tell — while a body that does not parse is still a 400,
 * because that one is a bug in the sender and the only place it can show up is
 * a test or a curl.
 *
 * The body names which sinks took the batch, which is what makes the wiring
 * checkable by hand:
 *
 * ```sh
 * curl -X POST localhost:3000/api/vitals -H 'content-type: application/json' \
 *   -d '{"sentAt":"2026-01-01T00:00:00.000Z","page":{"visitId":"v-demo"},
 *        "samples":[{"name":"LCP","value":2100,"rating":"good","id":"v1-1",
 *                    "navigationType":"navigate","route":"/"}]}'
 * ```
 */
export default defineEventHandler(async (event): Promise<VitalsIngestResult> => {
  const parsed = parseVitalsBatch(await readBody(event))

  if (!parsed.ok) {
    // Not logged. A public endpoint that wrote a line per malformed body would
    // let anyone fill the logs, and a mangled beacon is not an incident.
    throw createError({ statusCode: 400, message: parsed.message })
  }

  // Re-resolved per request rather than cached: it is a few string reads, and it
  // means a config change needs no process state to be invalidated. A URL that
  // does not parse throws here, but cannot in practice — `server/plugins/vitals.ts`
  // resolves the same plan at boot, so a misconfigured server never starts.
  const plan = resolveVitalsSinkPlan(useRuntimeConfig(event), import.meta.dev)
  const results = await deliverVitals(parsed.batch, vitalsSinksFor(plan))

  for (const result of results) {
    if (!result.ok) {
      warnVitals(`[vitals] ${result.name} sink failed: ${result.error}`)
    }
  }

  setResponseStatus(event, 202)

  return {
    accepted: parsed.batch.samples.length,
    sinks: results.filter((result) => result.ok).map((result) => result.name),
  }
})
