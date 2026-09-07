import { eq } from 'drizzle-orm'
import { todos } from '~/server/db/schema'
import { defineIdempotentHandler } from '~/server/utils/idempotent-route'

/**
 * Deleting is idempotent in effect and *not* in its response: the first attempt
 * is a 204 and every attempt after it is a 404, because the row is gone. A
 * client retrying a lost 204 therefore learns that its own delete failed. A key
 * makes the retry return the 204 it missed. See `docs/idempotency.md`.
 */
export default defineIdempotentHandler(async (event): Promise<void> => {
  const id = getRouterParam(event, 'id')

  if (!id) {
    throw createError({ statusCode: 400, message: 'Todo ID is required' })
  }

  const db = useDb()
  const [deleted] = await db.delete(todos).where(eq(todos.id, id)).returning({ id: todos.id })

  if (!deleted) {
    throw createError({ statusCode: 404, message: 'Todo not found' })
  }

  setResponseStatus(event, 204)
})
