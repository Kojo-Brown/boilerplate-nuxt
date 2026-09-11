import { defineIdempotentHandler } from '~/server/utils/idempotent-route'
import {
  conflictBody,
  conflictMessage,
  decidePrecondition,
  IF_MATCH_HEADER,
} from '~/server/utils/optimistic-concurrency'
import { enqueueOutbox } from '~/server/utils/outbox-store'
import { todoDeletedMessage } from '~/server/utils/todo-events'
import { readConflict, todoDeleteStatement } from '~/server/utils/todo-store'

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
 *
 * ## Why a delete needs a precondition too
 *
 * It is the easiest guard to argue away: the row ends up gone either way, so
 * what does it matter which version went? It matters because "delete this todo"
 * and "delete the todo I was looking at" are different requests, and only the
 * second is safe when somebody has since edited it into something the deleter
 * never saw. A stale delete is the one conflict that cannot be noticed
 * afterwards, because it leaves nothing behind to notice it with. See
 * `docs/optimistic-concurrency.md`; the status codes are the table in
 * `[id].patch.ts`.
 */
export default defineIdempotentHandler(async (event): Promise<void> => {
  const id = getRouterParam(event, 'id')

  if (!id) {
    throw createError({ statusCode: 400, message: 'Todo ID is required' })
  }

  const decision = decidePrecondition(getRequestHeader(event, IF_MATCH_HEADER), { required: true })

  if (decision.kind === 'required') {
    throw createError({
      statusCode: 428,
      message:
        `This route requires an ${IF_MATCH_HEADER} header carrying the version you read, ` +
        'e.g. If-Match: "4". GET the todo to find it in the ETag.',
      data: { requestId: event.context.requestId },
    })
  }

  if (decision.kind === 'malformed') {
    throw createError({
      statusCode: 400,
      message: `Invalid ${IF_MATCH_HEADER}: ${decision.reason}.`,
      data: { requestId: event.context.requestId },
    })
  }

  const db = useDb()
  await db.transaction(async (tx) => {
    const [deleted] = await todoDeleteStatement(tx, { id, expected: decision.expected })

    if (!deleted) {
      const { miss, current } = await readConflict(tx, id)

      throw createError({
        statusCode: miss.kind === 'missing' ? 404 : 412,
        message: conflictMessage(miss, decision.expected),
        data: {
          ...conflictBody(miss, current, decision.expected),
          requestId: event.context.requestId,
        },
      })
    }

    await enqueueOutbox(tx, [todoDeletedMessage(deleted.id, new Date(), deleted.version)])
  })

  setResponseStatus(event, 204)
})
