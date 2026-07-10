import { sql } from 'drizzle-orm'
import { todos, type Todo } from '~/server/db/schema'
import type { PaginatedResponse } from '~/types/api'

export default defineEventHandler(async (event): Promise<PaginatedResponse<Todo>> => {
  const query = getQuery(event)
  const page = Math.max(1, Number(query['page'] ?? 1))
  const limit = Math.min(100, Math.max(1, Number(query['limit'] ?? 10)))
  const offset = (page - 1) * limit

  const db = useDb()

  const [rows, countResult] = await Promise.all([
    db.select().from(todos).limit(limit).offset(offset).orderBy(todos.createdAt),
    db.select({ count: sql<number>`count(*)::int` }).from(todos),
  ])

  const total = countResult[0]?.count ?? 0

  return {
    data: rows,
    pagination: { total, page, limit, hasMore: page * limit < total },
    message: 'Todos retrieved successfully',
    statusCode: 200,
  }
})
