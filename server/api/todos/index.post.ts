import { todos, type Todo } from '~/server/db/schema'
import { defineIdempotentHandler } from '~/server/utils/idempotent-route'
import { createTodoSchema } from '~/server/utils/todo-schemas'
import type { ApiResponse } from '~/types/api'

/**
 * Creating a todo is the textbook case for an `Idempotency-Key`: nothing in the
 * request identifies the row, so a retry after a lost response produces a second
 * one that is indistinguishable from a deliberate duplicate. See
 * `docs/idempotency.md`.
 */
export default defineIdempotentHandler(async (event): Promise<ApiResponse<Todo>> => {
  const body = await readBody(event)
  const parsed = createTodoSchema.safeParse(body)

  if (!parsed.success) {
    throw createError({
      statusCode: 400,
      message: parsed.error.issues[0]?.message ?? 'Invalid request body',
    })
  }

  const db = useDb()
  const [created] = await db.insert(todos).values({ title: parsed.data.title }).returning()

  if (!created) {
    throw createError({ statusCode: 500, message: 'Failed to create todo' })
  }

  setResponseStatus(event, 201)

  return {
    data: created,
    message: 'Todo created successfully',
    statusCode: 201,
  }
})
