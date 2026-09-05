import { useWsConfig } from '~/server/utils/ws-config'
import { mintWsTicket } from '~/server/utils/ws-ticket'
import { wsTicketRequestSchema } from '~/server/utils/ws-schemas'
import { WS_TICKET_SUBPROTOCOL, type WsTicketResponse } from '~/types/websocket'
import type { ApiResponse } from '~/types/api'

/**
 * Mints a short-lived, single-use ticket for a WebSocket handshake.
 *
 * ```ts
 * const { data } = await $fetch('/api/ws/ticket', {
 *   method: 'POST',
 *   body: { channel: 'echo' },
 * })
 * const socket = new WebSocket('/api/ws/echo', [data.subprotocol, data.token])
 * ```
 *
 * ## This route is the security boundary, not the socket
 *
 * `server/utils/ws-ticket.ts` explains why the socket cannot authenticate itself
 * from the session cookie: a WebSocket handshake is exempt from the same-origin
 * policy, so a page on any origin can open one and the browser will attach this
 * app's cookies to it. The defence is a credential that a cross-origin page
 * cannot obtain — and *this* route is where that property has to hold. Three
 * things make it hold, and all three are load-bearing:
 *
 *  1. **It is a `POST`.** A cross-origin `GET` is a simple request; a form or an
 *     image tag can make one and no preflight is involved.
 *  2. **It requires `content-type: application/json`.** That is not one of the
 *     three content types CORS calls simple, so a cross-origin caller triggers a
 *     preflight — which this app answers for no foreign origin, because
 *     `route-rules.config.ts` sets `cors` on `/api/route-rules/**` and nothing
 *     else. The check is explicit below rather than left to `readBody`, which
 *     parses JSON regardless of the header it arrived under.
 *  3. **Its response is unreadable cross-origin.** Even a request that somehow
 *     reached the handler returns a body the calling page is not allowed to
 *     read, for the same missing `Access-Control-Allow-Origin`.
 *
 * The socket then only has to check a signature. What it must *not* do is accept
 * the cookie as a fallback when no ticket is presented, which would restore the
 * hole this whole route exists to close.
 *
 * ## Why the ticket is not just the session id
 *
 * Because a bearer credential that lives as long as the session, in a URL, is a
 * session cookie with none of a cookie's protections — no `HttpOnly`, no
 * `Secure`, no `SameSite`, and a lifetime measured in days. The ticket is signed
 * so the socket needs no lookup to trust it, scoped to one channel, valid for
 * seconds, and spent on first use.
 */
export default defineEventHandler(async (event): Promise<ApiResponse<WsTicketResponse>> => {
  const auth = requireAuth(event)

  const contentType = getRequestHeader(event, 'content-type') ?? ''
  if (!contentType.split(';')[0]?.trim().toLowerCase().endsWith('/json')) {
    // 415 rather than 400: the body may well be valid, it is the framing that is
    // refused. See point 2 above — this check is a CSRF control, not a nicety.
    throw createError({
      statusCode: 415,
      message: 'This endpoint requires a JSON request body (content-type: application/json)',
    })
  }

  const parsed = wsTicketRequestSchema.safeParse(await readBody(event))
  if (!parsed.success) {
    throw createError({
      statusCode: 400,
      message: parsed.error.issues[0]?.message ?? 'Invalid request body',
    })
  }

  if (auth.sessionId === null) {
    // Every session issued since PR #29 carries an id, minted by h3 when the
    // session is created. One without predates the registry, and a ticket that
    // could not name a session would be a socket nothing could ever revoke.
    throw createError({
      statusCode: 409,
      message: 'This session cannot open a WebSocket. Sign in again to get a session that can.',
    })
  }

  const { key, ticketTtlSeconds } = await useWsConfig()

  const { token, claims } = await mintWsTicket({
    key,
    userId: auth.user.id,
    sessionId: auth.sessionId,
    channel: parsed.data.channel,
    ttlSeconds: ticketTtlSeconds,
  })

  // A credential must not be cached, and `no-store` is the only directive that
  // covers a shared cache, a private one, and the back/forward cache alike.
  setResponseHeader(event, 'cache-control', 'no-store')

  return {
    data: {
      token,
      channel: claims.channel,
      expiresAt: claims.expiresAt,
      subprotocol: WS_TICKET_SUBPROTOCOL,
    },
    message: `Ticket valid for ${ticketTtlSeconds}s on the "${claims.channel}" channel`,
    statusCode: 200,
  }
})
