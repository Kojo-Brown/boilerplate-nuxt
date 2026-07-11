import { uploads } from '~/server/db/schema'
import type { PaginatedResponse } from '~/types/api'
import type { Upload } from '~/server/db/schema'
import { sql } from 'drizzle-orm'

export default defineEventHandler(async (event): Promise<PaginatedResponse<Upload>> => {
  const query = getQuery(event)
  const page = Math.max(1, Number(query['page'] ?? 1))
  const limit = Math.min(100, Math.max(1, Number(query['limit'] ?? 10)))
  const offset = (page - 1) * limit

  const db = useDb()

  const [rows, countResult] = await Promise.all([
    db.select().from(uploads).limit(limit).offset(offset).orderBy(uploads.createdAt),
    db.select({ count: sql<number>`count(*)::int` }).from(uploads),
  ])

  const total = countResult[0]?.count ?? 0

  return {
    data: rows,
    pagination: { total, page, limit, hasMore: page * limit < total },
    message: 'Uploads retrieved successfully',
    statusCode: 200,
  }
})
