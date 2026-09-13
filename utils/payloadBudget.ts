/**
 * Measuring what a server render sends to the browser, and failing loudly when
 * it grows.
 *
 * Everything `useAsyncData` resolves on the server is written to
 * `nuxtApp.payload.data[key]` and serialized into the HTML document, so the
 * browser downloads every response twice: once as rendered markup, once again
 * as JSON in `__NUXT__`. That second copy is invisible — no network panel entry,
 * no warning, no build error — and it is paid on first paint, before hydration,
 * on the connection the visitor actually has.
 *
 * The remedy is `pick` and `transform`, which run before Nuxt stores the value.
 * The point of measuring is that nothing else in the toolchain will tell you
 * when you have stopped using them. See `docs/async-data-caching.md`.
 */

/**
 * A payload budget in bytes. Not a hard limit anywhere — it is the number a
 * report is compared against, so a page can state what it thinks it costs and
 * find out when that stops being true.
 */
export const DEFAULT_PAYLOAD_BUDGET_BYTES = 16 * 1024

/**
 * UTF-8 byte length of `value` as JSON, or `null` when it has no JSON form.
 *
 * `null` covers two real cases and they are not errors: `undefined` and a
 * function serialize to nothing, and a circular structure throws. Nuxt's own
 * serializer (devalue) does handle cycles and a few types JSON drops, so this
 * is a close estimate of the payload cost rather than the exact byte count —
 * near enough to spot a response that doubled, which is what a budget is for,
 * and honest about being an estimate rather than pretending to a precision it
 * does not have.
 */
export function measurePayloadBytes(value: unknown): number | null {
  let json: string | undefined
  try {
    json = JSON.stringify(value)
  } catch {
    // Circular, or a BigInt. Either way there is no number to report.
    return null
  }

  if (json === undefined) return null
  return new TextEncoder().encode(json).length
}

/** Human-readable bytes, for a warning line or a demo panel. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return 'unknown'
  if (Math.abs(bytes) < 1024) return `${Math.round(bytes)} B`
  const kb = bytes / 1024
  if (Math.abs(kb) < 1024) return `${kb.toFixed(kb < 10 ? 2 : 1)} kB`
  return `${(kb / 1024).toFixed(2)} MB`
}

export interface PayloadBudgetReport {
  /** The `useAsyncData` key the value is stored under. */
  readonly key: string
  /** Measured size, or `null` when the value has no JSON form. */
  readonly bytes: number | null
  readonly budgetBytes: number
  /** False only when a size was measured and it exceeds the budget. */
  readonly withinBudget: boolean
  /**
   * The largest contributors, biggest first. Empty for a non-object value.
   * This is the part that turns "too big" into an edit: it names the fields a
   * `pick` would drop.
   */
  readonly largestFields: readonly PayloadFieldSize[]
}

export interface PayloadFieldSize {
  readonly field: string
  readonly bytes: number
}

/** How many fields a report names. Enough to act on, short enough to read. */
const MAX_REPORTED_FIELDS = 5

/**
 * Per-field sizes of an object or array, largest first.
 *
 * Sizes are measured independently, so they do not sum to the whole — the
 * enclosing braces, the commas, and the field names themselves are not
 * attributed to anyone. That is fine for the question being asked, which is
 * which field to drop, not where every byte went.
 */
export function payloadFieldSizes(value: unknown): readonly PayloadFieldSize[] {
  if (value === null || typeof value !== 'object') return []

  const sizes: PayloadFieldSize[] = []

  for (const [field, fieldValue] of Object.entries(value)) {
    const bytes = measurePayloadBytes(fieldValue)
    if (bytes === null) continue
    sizes.push({ field, bytes })
  }

  // Ties broken by field name so the report is stable across runs; an unstable
  // report is one that looks like a change when nothing changed.
  sizes.sort((a, b) => b.bytes - a.bytes || (a.field < b.field ? -1 : a.field > b.field ? 1 : 0))

  return sizes
}

/** Measures `value` and compares it against `budgetBytes`. */
export function checkPayloadBudget(
  key: string,
  value: unknown,
  budgetBytes: number = DEFAULT_PAYLOAD_BUDGET_BYTES,
): PayloadBudgetReport {
  const bytes = measurePayloadBytes(value)
  const withinBudget = bytes === null || bytes <= budgetBytes

  return {
    key,
    bytes,
    budgetBytes,
    withinBudget,
    // Only computed when it is going to be read. Measuring every field of an
    // in-budget response would mean re-serializing it on every fetch for a
    // report nobody looks at.
    largestFields: withinBudget ? [] : payloadFieldSizes(value).slice(0, MAX_REPORTED_FIELDS),
  }
}

/**
 * The warning text for an over-budget report, or `null` when it is within
 * budget.
 *
 * Returned rather than logged so the decision about *whether* to warn — dev
 * only, in this app — stays at the call site, and so the message itself can be
 * asserted in a test instead of scraped off the console.
 */
export function payloadBudgetWarning(report: PayloadBudgetReport): string | null {
  if (report.withinBudget || report.bytes === null) return null

  const offenders = report.largestFields
    .map((entry) => `${entry.field} (${formatBytes(entry.bytes)})`)
    .join(', ')

  const detail = offenders === '' ? '' : ` Largest fields: ${offenders}.`

  return (
    `[payload] "${report.key}" serializes to ${formatBytes(report.bytes)}, over its ` +
    `${formatBytes(report.budgetBytes)} budget. Every byte is sent twice on an SSR render — ` +
    `once as HTML, once in the __NUXT__ payload.${detail} Narrow it with \`pick\` or \`transform\`.`
  )
}
