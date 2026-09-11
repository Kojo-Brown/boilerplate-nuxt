import { eq } from 'drizzle-orm'
import { todos, type Todo } from '~/server/db/schema'
import { versionETag, ETAG_HEADER } from '~/server/utils/optimistic-concurrency'
import type { ApiResponse } from '~/types/api'

/**
 * The read half of optimistic concurrency: this is where a client learns which
 * version it is holding, so it has something to put in `If-Match` when it comes
 * back to write. See `docs/optimistic-concurrency.md`.
 */
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

  setResponseHeader(event, ETAG_HEADER, versionETag(todo.version))

  return {
    data: todo,
    message: 'Todo retrieved successfully',
    statusCode: 200,
  }
})
