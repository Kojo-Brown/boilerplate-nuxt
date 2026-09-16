import { z } from 'zod'

import {
  MAX_SAMPLES_PER_BATCH,
  VITAL_METRIC_NAMES,
  VITAL_NAVIGATION_TYPES,
  type VitalsBatch,
} from '~/types/vitals'

/**
 * What `/api/vitals` will accept, and the reasoning behind every bound.
 *
 * This endpoint is **public and unauthenticated** — it has to be, since a vitals
 * beacon is sent by logged-out visitors on public pages, and `sendBeacon` cannot
 * set a header — so the body is attacker-controlled by definition. Everything
 * below exists to make a forged batch boring rather than useful:
 *
 * - **Bounded arrays and strings.** `MAX_SAMPLES_PER_BATCH` samples, a 512-byte
 *   route, a 64-byte metric id. A batch that parses is small, so the aggregate
 *   cannot be grown by a large one and a forwarded batch cannot be used to
 *   amplify a request at the analytics sink.
 * - **Closed enums.** `name` and `navigationType` come from the two `as const`
 *   tuples in `types/vitals.ts`, so the aggregate's key space is finite no
 *   matter what is posted.
 * - **`.strict()` everywhere.** An unknown key is a rejection, not a passthrough.
 *   Without it, a forged batch could smuggle arbitrary JSON through this app and
 *   into a third-party sink, which would make this route an open relay with a
 *   thin JSON schema in front of it.
 * - **Finite, non-negative, capped values.** A metric value is a duration or a
 *   layout-shift score. `Infinity` and `NaN` do not survive `JSON.stringify`,
 *   but `1e308` does, and one such sample in a percentile window is enough to
 *   make every chart over it useless.
 *
 * What is deliberately *not* validated is truthfulness. Nothing here can tell a
 * real 4-second LCP from a fabricated one — no client-reported metric can be
 * trusted that way, from any analytics vendor. See the "what this data is worth"
 * section of `docs/web-vitals.md`; the mitigation is that the data is aggregated
 * and advisory, and nothing is gated on it.
 */

/** A day in milliseconds. Metric values are clamped well below anything real. */
const MAX_VALUE = 60 * 60 * 1000

const sampleSchema = z
  .object({
    name: z.enum(VITAL_METRIC_NAMES),
    value: z
      .number()
      .finite('A metric value must be a finite number')
      .nonnegative('A metric value cannot be negative')
      .max(MAX_VALUE, 'A metric value above one hour is not a measurement'),
    rating: z.enum(['good', 'needs-improvement', 'poor']),
    id: z.string().min(1, 'A sample needs a metric instance id').max(64),
    navigationType: z.enum(VITAL_NAVIGATION_TYPES),
    // Must be a path, not a URL: the browser strips the origin, query and hash
    // before sending (`routeFromUrl`), and accepting a full URL here would let a
    // forged beacon put an arbitrary external address into a sink's dashboard.
    route: z
      .string()
      .min(1, 'A sample needs a route')
      .max(512, 'A route must be 512 characters or less')
      .startsWith('/', 'A route must be a path beginning with "/"'),
  })
  .strict()

const pageSchema = z
  .object({
    visitId: z.string().min(1, 'A batch needs a visit id').max(64),
    connection: z.string().max(32).optional(),
    viewport: z
      .object({
        width: z.number().int().nonnegative().max(100_000),
        height: z.number().int().nonnegative().max(100_000),
      })
      .strict()
      .optional(),
  })
  .strict()

export const vitalsBatchSchema = z
  .object({
    sentAt: z.string().datetime({ offset: true, message: 'sentAt must be an ISO 8601 timestamp' }),
    page: pageSchema,
    samples: z
      .array(sampleSchema)
      .min(1, 'A batch with no samples has nothing to report')
      .max(MAX_SAMPLES_PER_BATCH, `A batch carries at most ${MAX_SAMPLES_PER_BATCH} samples`),
  })
  .strict()

export type VitalsBatchInput = z.infer<typeof vitalsBatchSchema>

/**
 * Parses a batch, returning either the value or the first problem with it.
 *
 * A result type rather than a throw, because the caller's two cases are not both
 * errors: `server/api/vitals/index.post.ts` answers a malformed beacon with 400
 * and no logging. A browser extension mangling a beacon, or a bot posting
 * nonsense to a public endpoint, is not an incident, and a route that logged
 * every one of them would hand anyone on the internet a way to fill the logs.
 */
export function parseVitalsBatch(
  body: unknown,
): { ok: true; batch: VitalsBatch } | { ok: false; message: string } {
  const parsed = vitalsBatchSchema.safeParse(body)
  if (parsed.success) return { ok: true, batch: parsed.data }

  return { ok: false, message: parsed.error.issues[0]?.message ?? 'Invalid vitals batch' }
}
