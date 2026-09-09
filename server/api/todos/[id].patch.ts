import { eq } from 'drizzle-orm'
import { todos, type Todo } from '~/server/db/schema'
import { defineIdempotentHandler } from '~/server/utils/idempotent-route'
import { enqueueOutbox } from '~/server/utils/outbox-store'
import { todoUpdatedMessage } from '~/server/utils/todo-events'
import { updateTodoSchema } from '~/server/utils/todo-schemas'
import type { ApiResponse } from '~/types/api'

/**
 * An update that sets fields to literal values is already idempotent in effect —
 * applying it twice leaves the same row. What a key adds here is a stable
 * *response*: the second attempt returns the first one's row rather than one
 * carrying a later `updatedAt`, so a client that retries cannot see the resource
 * change under it. See `docs/idempotency.md`.
 *
 * The update and its `todo.updated` event share one transaction — see
 * `docs/outbox.md`. A 404 is thrown from inside it, so a miss writes no event.
 */
export default defineIdempotentHandler(async (event): Promise<ApiResponse<Todo>> => {
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
  const updated = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(todos)
      .set({ ...parsed.data, updatedAt: new Date() })
      .where(eq(todos.id, id))
      .returning()

    if (!row) {
      throw createError({ statusCode: 404, message: 'Todo not found' })
    }

    await enqueueOutbox(tx, [todoUpdatedMessage(row)])
    return row
  })

  return {
    data: updated,
    message: 'Todo updated successfully',
    statusCode: 200,
  }
})
