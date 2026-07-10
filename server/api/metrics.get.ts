export interface ServerMetrics {
  requestCount: number
  uptimeSeconds: number
  timestamp: string
  memoryMb: number
}

let requestCount = 0

export default defineEventHandler((): ServerMetrics => {
  requestCount++

  const mem = process.memoryUsage()

  return {
    requestCount,
    uptimeSeconds: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
    memoryMb: Math.round(mem.rss / 1024 / 1024),
  }
})
