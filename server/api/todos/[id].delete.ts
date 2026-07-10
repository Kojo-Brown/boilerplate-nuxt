import { eq } from 'drizzle-orm'
import { todos } from '~/server/db/schema'

export default defineEventHandler(async (event): Promise<void> => {
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
