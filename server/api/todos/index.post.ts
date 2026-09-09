import { todos, type Todo } from '~/server/db/schema'
import { defineIdempotentHandler } from '~/server/utils/idempotent-route'
import { enqueueOutbox } from '~/server/utils/outbox-store'
import { todoCreatedMessage } from '~/server/utils/todo-events'
import { createTodoSchema } from '~/server/utils/todo-schemas'
import type { ApiResponse } from '~/types/api'

/**
 * Creating a todo is the textbook case for an `Idempotency-Key`: nothing in the
 * request identifies the row, so a retry after a lost response produces a second
 * one that is indistinguishable from a deliberate duplicate. See
 * `docs/idempotency.md`.
 *
 * The insert and the `todo.created` event share one transaction, so the row and
 * the announcement of it commit together — see `docs/outbox.md`. The two
 * mechanisms answer different halves of the same question: the key stops the
 * *client's* retry producing two todos, the outbox stops one todo producing zero
 * or two events.
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
  const created = await db.transaction(async (tx) => {
    const [row] = await tx.insert(todos).values({ title: parsed.data.title }).returning()

    // Thrown inside the transaction, so it rolls back rather than leaving a row
    // behind that nothing was told about.
    if (!row) {
      throw createError({ statusCode: 500, message: 'Failed to create todo' })
    }

    await enqueueOutbox(tx, [todoCreatedMessage(row)])
    return row
  })

  setResponseStatus(event, 201)

  return {
    data: created,
    message: 'Todo created successfully',
    statusCode: 201,
  }
})
