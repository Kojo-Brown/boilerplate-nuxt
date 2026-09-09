import { eq } from 'drizzle-orm'
import { todos } from '~/server/db/schema'
import { defineIdempotentHandler } from '~/server/utils/idempotent-route'
import { enqueueOutbox } from '~/server/utils/outbox-store'
import { todoDeletedMessage } from '~/server/utils/todo-events'

/**
 * Deleting is idempotent in effect and *not* in its response: the first attempt
 * is a 204 and every attempt after it is a 404, because the row is gone. A
 * client retrying a lost 204 therefore learns that its own delete failed. A key
 * makes the retry return the 204 it missed. See `docs/idempotency.md`.
 *
 * The delete is the case that most needs the outbox. The row is gone after it
 * commits, so a `todo.deleted` that was not written in the same transaction
 * could never be reconstructed from the database afterwards — there is nothing
 * left to reconstruct it from. See `docs/outbox.md`.
 */
export default defineIdempotentHandler(async (event): Promise<void> => {
  const id = getRouterParam(event, 'id')

  if (!id) {
    throw createError({ statusCode: 400, message: 'Todo ID is required' })
  }

  const db = useDb()
  await db.transaction(async (tx) => {
    const [deleted] = await tx.delete(todos).where(eq(todos.id, id)).returning({ id: todos.id })

    if (!deleted) {
      throw createError({ statusCode: 404, message: 'Todo not found' })
    }

    await enqueueOutbox(tx, [todoDeletedMessage(deleted.id, new Date())])
  })

  setResponseStatus(event, 204)
})
