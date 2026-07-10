import { eq } from 'drizzle-orm'
import { todos, type Todo } from '~/server/db/schema'
import type { ApiResponse } from '~/types/api'

export default defineEventHandler(async (event): Promise<ApiResponse<Todo>> => {
  const id = getRouterParam(event, 'id')

  if (!id) {
    throw createError({ statusCode: 400, message: 'Todo ID is required' })
  }

  const db = useDb()
  const [todo] = await db.select().from(todos).where(eq(todos.id, id))

  if (!todo) {
    throw createError({ statusCode: 404, message: 'Todo not found' })
  }

  return {
    data: todo,
    message: 'Todo retrieved successfully',
    statusCode: 200,
  }
})
