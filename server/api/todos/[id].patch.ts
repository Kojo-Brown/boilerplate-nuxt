import { eq } from 'drizzle-orm'
import { todos, type Todo } from '~/server/db/schema'
import { updateTodoSchema } from '~/server/utils/todo-schemas'
import type { ApiResponse } from '~/types/api'

export default defineEventHandler(async (event): Promise<ApiResponse<Todo>> => {
  const id = getRouterParam(event, 'id')

  if (!id) {
    throw createError({ statusCode: 400, message: 'Todo ID is required' })
  }

  const body = await readBody(event)
  const parsed = updateTodoSchema.safeParse(body)

  if (!parsed.success) {
    throw createError({
      statusCode: 400,
      message: parsed.error.issues[0]?.message ?? 'Invalid request body',
    })
  }

  if (Object.keys(parsed.data).length === 0) {
    throw createError({ statusCode: 400, message: 'No fields to update' })
  }

  const db = useDb()
  const [updated] = await db
    .update(todos)
    .set({ ...parsed.data, updatedAt: new Date() })
    .where(eq(todos.id, id))
    .returning()

  if (!updated) {
    throw createError({ statusCode: 404, message: 'Todo not found' })
  }

  return {
    data: updated,
    message: 'Todo updated successfully',
    statusCode: 200,
  }
})
