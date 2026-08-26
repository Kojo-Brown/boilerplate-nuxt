import {
  isSafeRequestId,
  REQUEST_ID_HEADERS,
  RESPONSE_REQUEST_ID_HEADER,
} from '~/server/utils/request-id'

/**
 * Request context — the first thing that runs on every request.
 *
 * Nitro registers everything in `server/middleware/` ahead of the route
 * handlers and runs it in **filename order**, which is why these files are
 * numbered: `00.request-context.ts` before `10.auth.ts`. The numbers are the
 * ordering mechanism, not decoration — rename this file to `request-context.ts`
 * and it sorts after `10.auth.ts`, which would leave the 401 thrown there with
 * no request id to report.
 *
 * Middleware that returns `undefined` does not handle the request; it falls
 * through to the next one and eventually to the route. Nothing here returns a
 * value, so this is pure context setup.
 *
 * `utils/api.ts` already stamps every outgoing call with `x-correlation-id`.
 * Until now nothing on the server read it, so a browser-side id and a server-side
 * log line could not be joined up. This adopts the caller's id when it sends a
 * usable one and mints a UUID when it does not, then echoes the result on the
 * response so a caller that supplied nothing still learns the id.
 */
export default defineEventHandler((event) => {
  const supplied = REQUEST_ID_HEADERS.map((header) => getRequestHeader(event, header)).find(
    (value) => isSafeRequestId(value),
  )

  event.context.requestId = supplied ?? crypto.randomUUID()
  event.context.requestReceivedAt = Date.now()

  setResponseHeader(event, RESPONSE_REQUEST_ID_HEADER, event.context.requestId)
})
