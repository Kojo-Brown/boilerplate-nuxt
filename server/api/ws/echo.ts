import { useWsConfig } from '~/server/utils/ws-config'
import {
  attachPrincipal,
  authorizeHandshake,
  readPrincipal,
  rejectionResponse,
  sessionReader,
  ticketSpender,
  type WsPrincipal,
} from '~/server/utils/ws-handshake'
import { isFrameWithinLimit, parseClientFrame } from '~/server/utils/ws-frames'
import { useSessionStore } from '~/server/utils/session-store'
import { useWsTicketStore } from '~/server/utils/ws-ticket'
import { WsCloseCode, type WsChannel, type WsServerFrame } from '~/types/websocket'

/**
 * The `echo` channel: an authenticated WebSocket, and the reference for every
 * other one this app grows.
 *
 * Connect to it the way `POST /api/ws/ticket` describes — fetch a ticket, then
 * `new WebSocket(url, [subprotocol, token])`. `docs/websockets.md` has the full
 * client, the attack this shape defends against, and the deployment checklist.
 *
 * ## Read `server/utils/ws-handshake.ts` before changing the `upgrade` hook
 *
 * Two things about it are not guessable from its signature and both fail
 * silently in the direction of letting people in:
 *
 *  - Only a real `Response` with a non-2xx status rejects the upgrade. A
 *    returned `{ status: 401 }` type-checks, reads like a rejection, and opens
 *    the socket. {@link rejectionResponse} is the only way this file says no.
 *  - `request.context` is non-writable, so the principal has to be mutated onto
 *    it. Assigning throws, and a throw that is not a `Response` rejects the
 *    socket with no response at all.
 *
 * ## What a handler owes a socket that an HTTP handler does not
 *
 * An HTTP request is authorised once and then it is over. A socket is authorised
 * once and then stays open — so everything the request path re-checks per
 * request has to be re-checked here on a timer, or not at all. This handler does
 * one of them: it closes a socket whose session has expired
 * ({@link WsCloseCode.SessionRevoked}), because a socket outliving the
 * credential that opened it is the failure mode that makes long-lived
 * connections worse than requests. Revocation *during* a connection is not
 * polled — see the known gaps in `docs/websockets.md`.
 */

/** The channel this route serves. Checked against the ticket's `aud` claim. */
const CHANNEL: WsChannel = 'echo'

/** How often an open socket re-checks its own session expiry. */
const EXPIRY_SWEEP_MS = 30_000

/**
 * Per-connection counters, keyed by peer.
 *
 * A `WeakMap` rather than a property on `peer.context`: the context object is
 * the one crossws built for the *upgrade*, and putting per-message mutable state
 * next to the immutable principal invites code that trusts one as much as the
 * other. Weak keys mean a closed peer's counters are collectable whether or not
 * `close` fired — which it does not, on a process that is being torn down.
 */
const connections = new WeakMap<object, ConnectionState>()

interface ConnectionState {
  received: number
  readonly expiryTimer: ReturnType<typeof setInterval> | null
}

export default defineWebSocketHandler({
  async upgrade(request) {
    const { key, allowedOrigins } = await useWsConfig()

    const result = await authorizeHandshake(request, {
      key,
      channel: CHANNEL,
      allowedOrigins,
      readSession: sessionReader(useSessionStore()),
      spendTicket: ticketSpender(useWsTicketStore()),
    })

    if (!result.ok) {
      // The reason stays here. The client gets a status and nothing else — see
      // `WsTicketFailure` for why telling it apart would be an oracle.
      console.warn(
        `[ws] upgrade refused on /api/ws/${CHANNEL}: ${result.rejection.reason} ` +
          `(${result.rejection.status})`,
      )
      return rejectionResponse(result.rejection)
    }

    if (result.principal.replayCheck === 'unchecked') {
      console.warn(
        `[ws] ticket ${result.principal.ticketId} accepted without a replay check — ` +
          'the sessions storage base was unreachable',
      )
    }

    if (!attachPrincipal(request.context, result.principal)) {
      console.error('[ws] upgrade request carried no context; refusing the socket')
      return rejectionResponse({ status: 401, reason: 'no-ticket' })
    }

    // No return value: crossws reads `undefined` as "proceed". Returning
    // `{ headers }` here would set response headers on the 101 — the place to
    // put a `Sec-Websocket-Protocol` if the adapter ever stopped selecting the
    // first offered protocol itself, which is the marker rather than the token
    // precisely because it is echoed.
  },

  open(peer) {
    const principal = readPrincipal(peer.context)

    if (principal === null) {
      // Unreachable while `upgrade` is the only way in, and closed rather than
      // trusted anyway: a peer with no principal is a peer whose handshake this
      // file did not authorise, and there is no safe interpretation of that.
      console.error('[ws] a peer opened with no principal; closing')
      peer.close(WsCloseCode.SessionRevoked, 'unauthenticated')
      return
    }

    connections.set(peer, {
      received: 0,
      expiryTimer: startExpirySweep(peer, principal),
    })

    send(peer, {
      type: 'welcome',
      peerId: peer.id,
      channel: principal.channel,
      userId: principal.userId,
      connectedAt: principal.connectedAt,
      sessionExpiresAt: principal.sessionExpiresAt,
    })
  },

  message(peer, message) {
    const principal = readPrincipal(peer.context)
    const state = connections.get(peer)
    if (principal === null || state === undefined) return

    const text = message.text()

    // Measured in bytes, not characters: the cap is about what the process has
    // to hold, and one emoji is four bytes of it.
    if (!isFrameWithinLimit(text)) {
      peer.close(WsCloseCode.MessageTooLarge, 'frame too large')
      return
    }

    const frame = parseClientFrame(text)
    if (frame === null) {
      // A peer that cannot frame JSON cannot read an error frame either, so this
      // one closes rather than replying. A frame that *is* JSON but says
      // something unknown gets an error and stays connected — see below.
      peer.close(WsCloseCode.ProtocolError, 'expected a JSON object with a known "type"')
      return
    }

    switch (frame.type) {
      case 'ping':
        send(peer, {
          type: 'pong',
          ...(frame.nonce === undefined ? {} : { nonce: frame.nonce }),
          at: Date.now(),
        })
        return

      case 'echo':
        state.received += 1
        send(peer, { type: 'echoed', text: frame.text, seq: state.received })
        return

      case 'whoami':
        send(peer, {
          type: 'identity',
          userId: principal.userId,
          channel: principal.channel,
          ticketId: principal.ticketId,
        })
        return
    }
  },

  close(peer, details) {
    const state = connections.get(peer)
    if (state?.expiryTimer) clearInterval(state.expiryTimer)
    connections.delete(peer)

    // Only an abnormal end. A connection that closed cleanly is not news, and a
    // line per socket is how a log stops being read — the same rule the SSE
    // handler applies to a stream that ran to completion.
    if (isAbnormalClose(details.code)) {
      const principal = readPrincipal(peer.context)
      console.warn(
        `[ws] /api/ws/${CHANNEL} closed abnormally for ${principal?.userId ?? 'unknown'} ` +
          `after ${state?.received ?? 0} frames (code ${details.code ?? '?'}` +
          `${details.reason ? `, ${details.reason}` : ''})`,
      )
    }
  },

  error(peer, error) {
    console.error(`[ws] /api/ws/${CHANNEL} transport error:`, error)
    const state = connections.get(peer)
    if (state?.expiryTimer) clearInterval(state.expiryTimer)
    connections.delete(peer)
  },
})

/**
 * Closes the socket when the session behind it expires.
 *
 * The handshake proved the session was live at `connectedAt`. Nothing re-proves
 * it, so without this a socket opened a minute before a session expired would
 * stay authorised indefinitely — the credential ends and the connection does
 * not, which is the whole difference between a socket and a request.
 *
 * Returns `null` for a session with no known expiry (`sessionStatus` reports
 * `unknown` for a record the registry does not have, and lets it through for the
 * reasons `session-store.ts` gives). There is nothing to enforce in that case,
 * and an interval that can never fire is a timer holding the event loop open.
 */
function startExpirySweep(
  peer: { close: (code?: number, reason?: string) => void },
  principal: WsPrincipal,
): ReturnType<typeof setInterval> | null {
  if (!Number.isFinite(principal.sessionExpiresAt)) return null

  const timer = setInterval(() => {
    if (Date.now() < principal.sessionExpiresAt) return
    clearInterval(timer)
    peer.close(WsCloseCode.SessionRevoked, 'session expired')
  }, EXPIRY_SWEEP_MS)

  // Node keeps the process alive for a pending timer, which on a server with one
  // idle socket would delay every shutdown by up to `EXPIRY_SWEEP_MS`.
  timer.unref?.()
  return timer
}

/**
 * Whether a close code is worth a log line.
 *
 * 1000 is a deliberate close and 1005 is "no code was sent", which is what a
 * browser reports for `socket.close()` with no arguments — both are the ordinary
 * end of a connection. Everything else, 1006 included, is something that
 * happened to the socket rather than something it did.
 */
function isAbnormalClose(code: number | undefined): boolean {
  return code !== undefined && code !== WsCloseCode.Normal && code !== 1005
}

/** The only way a frame leaves this file, so every one of them is typed. */
function send(peer: { send: (data: unknown) => unknown }, frame: WsServerFrame): void {
  peer.send(JSON.stringify(frame))
}
