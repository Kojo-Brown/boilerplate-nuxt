import type { Todo } from '~/server/db/schema'
import { defineIdempotentHandler } from '~/server/utils/idempotent-route'
import {
  conflictBody,
  conflictMessage,
  decidePrecondition,
  versionETag,
  ETAG_HEADER,
  IF_MATCH_HEADER,
} from '~/server/utils/optimistic-concurrency'
import { enqueueOutbox } from '~/server/utils/outbox-store'
import { todoUpdatedMessage } from '~/server/utils/todo-events'
import { updateTodoSchema } from '~/server/utils/todo-schemas'
import { readConflict, todoUpdateStatement } from '~/server/utils/todo-store'
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
 *
 * ## The precondition is required
 *
 * `If-Match` is not optional on this route. Without it the request is a
 * last-write-wins write, and a route that accepts both hands every client the
 * ability to opt out of the guarantee by forgetting to send a header. See
 * `docs/optimistic-concurrency.md`.
 *
 * Note how little of the mechanism is in this file. The header rules are in
 * `optimistic-concurrency.ts`; the guard is in the statement `todo-store.ts`
 * emits; what is left here is the translation from an outcome to a status code,
 * which is the only part that is actually about HTTP.
 *
 * | Situation                   | Status | Why |
 * | --------------------------- | ------ | --- |
 * | No `If-Match`               | 428    | RFC 6585 §3 — the request is fine, just unconditional |
 * | Unparseable `If-Match`      | 400    | The client has a bug; a silently ignored precondition would hide it |
 * | Row is gone                 | 404    | There is no target resource; the same answer `GET` gives |
 * | Row exists at a new version | 412    | RFC 9110 §13.1.1 — a failed `If-Match` on a state-changing request |
 *
 * 409 Conflict is the other status in common use for this, and it is the right
 * one for an API that carries the expected version *in the body*. Here the
 * precondition is a conditional request in the sense the HTTP specification
 * defines, so 412 is the status that already means it — and it keeps a version
 * conflict distinguishable from the 409 `defineIdempotentHandler` answers when a
 * request with the same `Idempotency-Key` is still in flight.
 */
export default defineIdempotentHandler(async (event): Promise<ApiResponse<Todo>> => {
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
    const [row] = await todoUpdateStatement(tx, {
      id,
      expected: decision.expected,
      values: parsed.data,
      now: new Date(),
    })

    if (!row) {
      // No row matched: either the id names nothing, or the version moved on.
      // The re-read runs on `tx`, so it answers from the snapshot the update ran
      // against rather than from whatever the table looks like a moment later.
      const { miss, current } = await readConflict(tx, id)

      if (miss.kind === 'missing') {
        // Deleted, or never there — indistinguishable from here, and the client
        // does the same thing with both. `current: null` is the part the conflict
        // UI reads: there is no other version to merge against.
        throw createError({
          statusCode: 404,
          message: conflictMessage(miss, decision.expected),
          data: {
            ...conflictBody(miss, current, decision.expected),
            requestId: event.context.requestId,
          },
        })
      }

      throw createError({
        statusCode: 412,
        message: conflictMessage(miss, decision.expected),
        data: {
          ...conflictBody(miss, current, decision.expected),
          requestId: event.context.requestId,
        },
      })
    }

    await enqueueOutbox(tx, [todoUpdatedMessage(row)])
    return row
  })

  // The version the caller now holds. Without it a client has to re-read before
  // it can make a second edit — a round trip for a number this response already
  // knows.
  setResponseHeader(event, ETAG_HEADER, versionETag(updated.version))

  return {
    data: updated,
    message: 'Todo updated successfully',
    statusCode: 200,
  }
})
