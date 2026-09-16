import { resolveVitalsSinkPlan, vitalsBootWarning } from '~/server/utils/vitals-sink'

/**
 * Validates the Web Vitals sink configuration once, at startup.
 *
 * `/api/vitals` resolves the same plan per request, so this plugin adds no
 * capability — what it adds is *when* a bad `NUXT_VITALS_SINK_URL` is noticed.
 * Without it, a typo'd collector address would boot cleanly and fail on every
 * beacon, which is a 500 nobody sees: the caller is `sendBeacon`, which ignores
 * the response. Throwing here means a misconfigured server does not start, the
 * stance `server/utils/storage.ts` documents for Redis.
 *
 * The one warning it can emit is the opposite case and is not an error: a built
 * server with no forwarding sink still collects into the in-process aggregate,
 * and an operator should know at boot that what they have is a rolling window
 * per instance rather than history.
 */
export default defineNitroPlugin(() => {
  const plan = resolveVitalsSinkPlan(useRuntimeConfig(), import.meta.dev)

  const warning = vitalsBootWarning(plan, import.meta.dev)
  if (warning) console.warn(warning)
})
