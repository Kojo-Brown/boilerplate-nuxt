/**
 * The WebSocket protocol this app speaks, and the vocabulary of its handshake.
 *
 * `types/sse.ts` ends by saying that a stream needing a request body, per-message
 * framing in both directions, binary data, or anything other than `GET` wants
 * "the WebSocket item that follows this one in `SPEC.md`". This is that item's
 * half of the wire.
 *
 * ## Why the handshake needs a vocabulary at all
 *
 * A WebSocket upgrade is an ordinary HTTP `GET` right up to the `101`, and then
 * it stops being one. Three consequences shape everything below:
 *
 *  1. **The browser cannot set request headers on it.** `new WebSocket(url)`
 *     takes a URL and a subprotocol list, and nothing else. There is no
 *     `Authorization: Bearer …` to send, which is why a token has to travel
 *     either in the query string or in the subprotocol list — see
 *     {@link WS_TICKET_SUBPROTOCOL}.
 *  2. **The handshake is not subject to the same-origin policy.** No preflight,
 *     no `Access-Control-Allow-Origin`, no opt-in. Any page on any origin can
 *     open a WebSocket to this app, and the browser will attach this app's
 *     cookies to it. That is cross-site WebSocket hijacking, and it is why
 *     cookie-only auth on a socket is broken by default rather than merely
 *     unfashionable. `docs/websockets.md` has the attack written out.
 *  3. **There is no status code after the `101`.** Everything that goes wrong
 *     later is a close code and a reason string — {@link WsCloseCode} — or an
 *     application-level error frame, the same split `types/sse.ts` describes
 *     for a stream that fails after its first byte.
 *
 * ## The frames
 *
 * Both directions carry JSON objects with a `type` discriminant. Text, not
 * binary: this channel is a demo of the handshake, and a protocol you can read
 * in the network panel is worth more here than one that is compact.
 */

/**
 * The channels a ticket can be minted for.
 *
 * A ticket is minted for exactly one channel and the handshake checks it against
 * the route being upgraded — so a ticket issued for a future `/api/ws/chat` is
 * not a ticket for `/api/ws/echo`. The claim it lands in is `aud`, which is the
 * JWT claim that already means "the recipient this token is for", validated by
 * `jose` rather than by hand.
 *
 * It is a closed union rather than a `string` because the ticket route accepts
 * this value from the client, and an open one would let a caller mint tickets
 * for channels that do not exist yet.
 */
export const WS_CHANNELS = ['echo'] as const

export type WsChannel = (typeof WS_CHANNELS)[number]

export function isWsChannel(value: unknown): value is WsChannel {
  return typeof value === 'string' && (WS_CHANNELS as readonly string[]).includes(value)
}

/**
 * The subprotocol that marks a ticket-bearing handshake.
 *
 * `new WebSocket(url, [WS_TICKET_SUBPROTOCOL, token])` is the one way a browser
 * can put a credential somewhere other than the URL: the list becomes a
 * `Sec-Websocket-Protocol` request header, which is a header the browser sets on
 * the client's behalf. The marker goes **first** because the server selects the
 * first entry it is offered, and a `101` whose `Sec-Websocket-Protocol` echoed
 * the token back would write the credential into the response as well.
 *
 * The `.v1` is not decoration. A subprotocol name is the only version negotiation
 * a WebSocket has, and it is checked before any frame is sent — so a client that
 * predates a breaking change to these types fails at the handshake instead of at
 * the first message it cannot parse.
 */
export const WS_TICKET_SUBPROTOCOL = 'nuxt.ws.ticket.v1'

/**
 * The query parameter a ticket may arrive in instead.
 *
 * Supported because not every client can offer a subprotocol — some proxies drop
 * the header, and some runtimes' WebSocket clients do not expose it — and
 * documented as the second choice because a query string is the part of a
 * request most likely to be written to an access log, a referrer, or an APM
 * trace. The ticket's short lifetime and single use exist mostly to make this
 * transport survivable; see `server/utils/ws-ticket.ts`.
 */
export const WS_TICKET_QUERY_PARAM = 'ticket'

/** The response of `POST /api/ws/ticket`. */
export interface WsTicketResponse {
  /** The compact JWS to hand to the handshake. Treat it as a credential. */
  readonly token: string
  /** The channel it is valid for, echoed so a client cannot mix two up. */
  readonly channel: WsChannel
  /** Epoch milliseconds at which the ticket stops verifying. */
  readonly expiresAt: number
  /**
   * The subprotocol to offer alongside the token. Sent by the server so the
   * client never hard-codes a constant the server might have moved on from.
   */
  readonly subprotocol: typeof WS_TICKET_SUBPROTOCOL
}

/**
 * Close codes this app sends.
 *
 * 4000-4999 is the range RFC 6455 reserves for applications, and it is the only
 * range whose meaning is ours to define. The two standard codes below are here
 * because they are the ones a handshake failure has to reuse: a socket rejected
 * *before* the `101` never reaches a close code at all — the client sees a
 * failed HTTP request and an `error` event with no detail, which is the single
 * most confusing thing about debugging WebSocket auth.
 */
export const WsCloseCode = {
  /** Normal, deliberate close from either end. */
  Normal: 1000,
  /** The server is going away (shutdown, deploy). Clients should reconnect. */
  GoingAway: 1001,
  /** A frame that is not JSON, is not an object, or has no known `type`. */
  ProtocolError: 4000,
  /** The session behind the ticket was revoked while the socket was open. */
  SessionRevoked: 4001,
  /** A frame exceeded {@link WS_MAX_FRAME_BYTES}. */
  MessageTooLarge: 4002,
} as const

export type WsCloseCode = (typeof WsCloseCode)[keyof typeof WsCloseCode]

/**
 * The largest text frame this app will parse, in bytes.
 *
 * A cap belongs on any endpoint that parses attacker-controlled input, and a
 * socket needs one more than a request does: an HTTP body is read once and the
 * connection ends, while a socket can send frames until it is closed. The number
 * is deliberately small — these are control messages, not uploads.
 */
export const WS_MAX_FRAME_BYTES = 16 * 1024

// ─── Client → server ─────────────────────────────────────────────────────────

/** A round-trip liveness probe, distinct from the protocol-level ping/pong. */
export interface WsPingFrame {
  readonly type: 'ping'
  /** Echoed back on the pong so a client can measure one specific round trip. */
  readonly nonce?: string
}

/** Ask the server to send the payload back. */
export interface WsEchoFrame {
  readonly type: 'echo'
  readonly text: string
}

/** Ask the server who it thinks is on the other end of this socket. */
export interface WsWhoamiFrame {
  readonly type: 'whoami'
}

export type WsClientFrame = WsPingFrame | WsEchoFrame | WsWhoamiFrame

// ─── Server → client ─────────────────────────────────────────────────────────

/**
 * The first frame on every accepted socket.
 *
 * It exists because a `101` proves the *handshake* succeeded and nothing else. A
 * client that treats `onopen` as "authenticated" is trusting a status line it
 * cannot see; this frame is the server saying which identity it actually
 * resolved, which is also the only way the client learns its own `peerId` for a
 * log correlation.
 */
export interface WsWelcomeFrame {
  readonly type: 'welcome'
  readonly peerId: string
  readonly channel: WsChannel
  readonly userId: string
  /** Epoch milliseconds when the handshake completed. */
  readonly connectedAt: number
  /**
   * Epoch milliseconds at which the *session* behind this socket expires.
   *
   * A socket outliving its session is the WebSocket-shaped version of the
   * problem `session-store.ts` was written for: the credential was checked once,
   * at the handshake, and nothing re-checks it afterwards. The server enforces
   * this itself; the value is sent so a client can reconnect before being cut
   * off rather than after.
   */
  readonly sessionExpiresAt: number
}

export interface WsPongFrame {
  readonly type: 'pong'
  readonly nonce?: string
  /** Server time, so a client can compare clocks as well as measure latency. */
  readonly at: number
}

export interface WsEchoedFrame {
  readonly type: 'echoed'
  readonly text: string
  /** 1-based index of this frame on this connection. */
  readonly seq: number
}

export interface WsIdentityFrame {
  readonly type: 'identity'
  readonly userId: string
  readonly channel: WsChannel
  /** The ticket's `jti`. Useful in a log; useless as a credential once burned. */
  readonly ticketId: string
}

/**
 * An application-level error that does not close the socket.
 *
 * The counterpart of `SSE_ERROR_EVENT` in `types/sse.ts`, and here for the same
 * reason: the status code is long gone. A frame the server cannot act on is a
 * client bug worth reporting, not necessarily grounds for hanging up — so a
 * malformed `echo` gets one of these, while a frame that is not JSON at all gets
 * {@link WsCloseCode.ProtocolError}, because a peer that cannot frame JSON will
 * not be able to read this either.
 */
export interface WsErrorFrame {
  readonly type: 'error'
  /** Written for the client. Never the text of a thrown error. */
  readonly message: string
}

export type WsServerFrame =
  WsWelcomeFrame | WsPongFrame | WsEchoedFrame | WsIdentityFrame | WsErrorFrame
