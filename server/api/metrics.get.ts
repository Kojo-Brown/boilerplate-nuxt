export interface ServerMetrics {
  requestCount: number
  uptimeSeconds: number
  timestamp: string
  memoryMb: number
  /**
   * The correlation id `server/middleware/00.request-context.ts` resolved for
   * this request — the same value the response carries in `x-request-id`, and
   * the same one the browser sent as `x-correlation-id` if it sent one.
   */
  requestId: string
}

let requestCount = 0

export default defineEventHandler((event): ServerMetrics => {
  requestCount++

  const mem = process.memoryUsage()

  return {
    requestCount,
    uptimeSeconds: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
    memoryMb: Math.round(mem.rss / 1024 / 1024),
    // Typed as `string` rather than `any` because of the `H3EventContext`
    // augmentation in server/types/h3.d.ts.
    requestId: event.context.requestId,
  }
})
