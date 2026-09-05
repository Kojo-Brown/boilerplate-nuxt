import { onScopeDispose, readonly, ref, shallowRef, type Ref, type ShallowRef } from 'vue'

import type { ApiResponse } from '~/types/api'
import {
  WsCloseCode,
  type WsChannel,
  type WsClientFrame,
  type WsServerFrame,
  type WsTicketResponse,
} from '~/types/websocket'

/**
 * The client half of `server/api/ws/echo.ts`: fetch a ticket, open the socket,
 * read typed frames, and reconnect when it drops.
 *
 * ```ts
 * const { status, frames, send, connect, disconnect } = useWsChannel('echo')
 * onMounted(connect)
 * send({ type: 'echo', text: 'hello' })
 * ```
 *
 * ## A ticket per attempt, not per session
 *
 * The single most common way to break this endpoint is to hold a ticket and
 * reuse it. A handshake ticket is spent on first use and lives 30 seconds, so a
 * cached one fails as `ticket-replayed` on the second connect and as
 * `ticket-expired` a minute later — and neither reason reaches the client (see
 * "Debugging a refused handshake" in `docs/websockets.md`). {@link connect}
 * fetches a fresh ticket on every attempt, including every reconnect, which is
 * what makes the credential's shortness free rather than a nuisance.
 *
 * ## `onopen` is not "authenticated"
 *
 * A refused upgrade reaches JavaScript as an `error` event with no status and a
 * `close` with code 1006. A *successful* one reaches it as `open` — which proves
 * the handshake completed and nothing about who the server thinks you are. This
 * composable reports `connected` only once the server's `welcome` frame arrives
 * carrying the resolved identity, so `status` means what a caller would assume it
 * means.
 *
 * ## Client only, and SSR-safe
 *
 * `connect()` resolves immediately on the server. There is no `WebSocket` in a
 * Nitro render and nothing useful to do with one: the HTML has to be finished and
 * sent, and a socket opened during SSR would have no client to deliver to. No
 * module-scope state either — `CLAUDE.md`'s rule, enforced by
 * `eslint-rules/composable-design.mjs`, and here it is also load-bearing: shared
 * connection state would mean one visitor's socket in another visitor's render.
 *
 * ## Keepalive
 *
 * Every proxy between the browser and the handler culls an idle connection on its
 * own timeout, exactly as `docs/sse.md` describes for a stream. WebSocket has
 * protocol-level ping frames, but the browser API cannot send one and the `ws`
 * server under crossws does not send them unprompted, so the keepalive has to be
 * an application frame. {@link DEFAULT_KEEPALIVE_MS} is 25 seconds, under the
 * 60-second floor an ALB or nginx defaults to.
 */

export type WsChannelStatus = 'idle' | 'connecting' | 'connected' | 'closed' | 'error'

/** Under the smallest idle timeout a socket is likely to meet. */
export const DEFAULT_KEEPALIVE_MS = 25_000

/** First reconnect delay. Doubles per attempt up to {@link MAX_BACKOFF_MS}. */
export const BASE_BACKOFF_MS = 500

export const MAX_BACKOFF_MS = 30_000

/** Attempts before {@link useWsChannel} stops trying and reports `error`. */
export const MAX_RECONNECT_ATTEMPTS = 6

export interface UseWsChannelOptions {
  /** Reconnect on an unexpected close. Defaults to `true`. */
  readonly autoReconnect?: boolean
  /** Idle gap before an application-level ping. `0` disables it. */
  readonly keepaliveMs?: number
  /** How many frames to retain. Older ones are dropped. Defaults to 100. */
  readonly historyLimit?: number
  /**
   * Injected so tests can drive the composable without a network. Defaults to
   * the global `WebSocket`.
   */
  readonly createSocket?: (url: string, protocols: string[]) => WebSocketLike
  /** Injected so tests need no server. Defaults to `POST /api/ws/ticket`. */
  readonly fetchTicket?: (channel: WsChannel) => Promise<WsTicketResponse>
  /** Injected so a test does not wait in real time. */
  readonly scheduler?: (fn: () => void, ms: number) => () => void
}

/**
 * The part of `WebSocket` this composable uses.
 *
 * Structural rather than the DOM type, for the reason `todoGateway.ts` states
 * for `TodoGateway`: a port a fake can implement is what lets the reconnect
 * logic be tested at all, and `WebSocket` is not constructible without a server.
 */
export interface WebSocketLike {
  readonly readyState: number
  send: (data: string) => void
  close: (code?: number, reason?: string) => void
  addEventListener: (type: string, listener: (event: never) => void) => void
}

export interface UseWsChannelReturn {
  readonly status: Readonly<Ref<WsChannelStatus>>
  /** Frames received, newest last, capped at `historyLimit`. */
  readonly frames: ShallowRef<WsServerFrame[]>
  /** The identity the server reported in its `welcome`, or `null`. */
  readonly identity: Readonly<Ref<WelcomeIdentity | null>>
  /** Set when a connection attempt failed or the socket closed abnormally. */
  readonly error: Readonly<Ref<string | null>>
  /** Reconnect attempts made since the last successful `welcome`. */
  readonly attempts: Readonly<Ref<number>>
  connect: () => Promise<void>
  /** Closes deliberately: no reconnect, and the attempt counter resets. */
  disconnect: () => void
  /** Returns `false` when there is no open socket to send on. */
  send: (frame: WsClientFrame) => boolean
}

export interface WelcomeIdentity {
  readonly peerId: string
  readonly userId: string
  readonly channel: WsChannel
  readonly connectedAt: number
  readonly sessionExpiresAt: number
}

export function useWsChannel(
  channel: WsChannel,
  options: UseWsChannelOptions = {},
): UseWsChannelReturn {
  const {
    autoReconnect = true,
    keepaliveMs = DEFAULT_KEEPALIVE_MS,
    historyLimit = 100,
    createSocket = defaultCreateSocket,
    fetchTicket = defaultFetchTicket,
    scheduler = defaultScheduler,
  } = options

  const status = ref<WsChannelStatus>('idle')
  const frames = shallowRef<WsServerFrame[]>([])
  const identity = ref<WelcomeIdentity | null>(null)
  const error = ref<string | null>(null)
  const attempts = ref(0)

  let socket: WebSocketLike | null = null
  let cancelReconnect: (() => void) | null = null
  let cancelKeepalive: (() => void) | null = null
  /**
   * The connection this closure belongs to. Every handler is guarded on still
   * being the current one — a socket replaced mid-flight still fires `close`,
   * and an old one reporting its own end as the state of its successor is the
   * same superseded-run bug `useNdjsonStream` guards against.
   */
  let generation = 0
  /** Set by `disconnect()`, so a deliberate close is not reconnected. */
  let closedByUs = false

  async function connect(): Promise<void> {
    if (import.meta.server) return
    if (status.value === 'connecting' || status.value === 'connected') return

    const run = ++generation
    closedByUs = false
    status.value = 'connecting'
    error.value = null

    let ticket: WsTicketResponse
    try {
      ticket = await fetchTicket(channel)
    } catch (cause) {
      if (run !== generation) return
      // A 401 here is the honest signal the socket cannot give: the ticket route
      // is a normal fetch, so it can say *why*.
      error.value = describeTicketFailure(cause)
      status.value = 'error'
      scheduleReconnect(run)
      return
    }

    if (run !== generation) return

    try {
      socket = createSocket(socketUrl(channel), [ticket.subprotocol, ticket.token])
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : 'Could not open the socket'
      status.value = 'error'
      scheduleReconnect(run)
      return
    }

    socket.addEventListener('message', (event: MessageEvent<string>) => {
      if (run !== generation) return
      const frame = parseServerFrame(event.data)
      if (frame === null) return

      if (frame.type === 'welcome') {
        // Not `open`: the 101 says the handshake finished, this says who the
        // server resolved. Resetting the backoff here rather than on `open`
        // means a socket that opens and is immediately closed does not look
        // like a healthy connection to the reconnect logic.
        attempts.value = 0
        status.value = 'connected'
        identity.value = {
          peerId: frame.peerId,
          userId: frame.userId,
          channel: frame.channel,
          connectedAt: frame.connectedAt,
          sessionExpiresAt: frame.sessionExpiresAt,
        }
        startKeepalive(run)
      }

      if (frame.type === 'error') error.value = frame.message

      frames.value = [...frames.value, frame].slice(-historyLimit)
    })

    socket.addEventListener('close', (event: CloseEvent) => {
      if (run !== generation) return
      stopKeepalive()
      socket = null
      status.value = closedByUs ? 'idle' : 'closed'

      if (closedByUs) return

      error.value = describeClose(event.code, event.reason)
      // A session that ended will refuse the next handshake too, so retrying is
      // a loop against a wall. Everything else — a proxy timeout, a deploy, a
      // dropped network — is what the backoff is for.
      if (event.code !== WsCloseCode.SessionRevoked) scheduleReconnect(run)
      else status.value = 'error'
    })

    socket.addEventListener('error', () => {
      if (run !== generation) return
      // A refused upgrade arrives here with no status and no reason; the browser
      // deliberately withholds both. `close` follows with 1006 and does the
      // reporting, so this handler only has to not overwrite it.
      if (error.value === null) error.value = 'The connection failed.'
    })
  }

  function disconnect(): void {
    closedByUs = true
    generation++
    cancelReconnect?.()
    cancelReconnect = null
    stopKeepalive()
    attempts.value = 0
    socket?.close(WsCloseCode.Normal, 'client closed')
    socket = null
    status.value = 'idle'
  }

  function send(frame: WsClientFrame): boolean {
    if (socket === null || status.value !== 'connected') return false
    socket.send(JSON.stringify(frame))
    return true
  }

  function scheduleReconnect(run: number): void {
    if (!autoReconnect || run !== generation) return

    if (attempts.value >= MAX_RECONNECT_ATTEMPTS) {
      status.value = 'error'
      error.value = `Gave up after ${MAX_RECONNECT_ATTEMPTS} attempts. ${error.value ?? ''}`.trim()
      return
    }

    const delay = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** attempts.value)
    attempts.value += 1
    cancelReconnect?.()
    cancelReconnect = scheduler(() => {
      cancelReconnect = null
      if (run === generation) void connect()
    }, delay)
  }

  function startKeepalive(run: number): void {
    stopKeepalive()
    if (keepaliveMs <= 0) return

    const tick = (): void => {
      if (run !== generation) return
      send({ type: 'ping' })
      cancelKeepalive = scheduler(tick, keepaliveMs)
    }
    cancelKeepalive = scheduler(tick, keepaliveMs)
  }

  function stopKeepalive(): void {
    cancelKeepalive?.()
    cancelKeepalive = null
  }

  // Bound to the scope, not to a component: `useWsChannel` inside another
  // composable's `effectScope` is torn down with that scope. See
  // `utils/sharedComposable.ts` for why the distinction matters.
  onScopeDispose(disconnect)

  return {
    status: readonly(status),
    frames,
    identity: readonly(identity) as Readonly<Ref<WelcomeIdentity | null>>,
    error: readonly(error),
    attempts: readonly(attempts),
    connect,
    disconnect,
    send,
  }
}

/**
 * `/api/ws/<channel>` as an absolute `ws:`/`wss:` URL.
 *
 * A relative URL is not accepted by every `WebSocket` implementation, and the
 * scheme has to be derived from the page's rather than hard-coded: a page on
 * `https:` may not open a `ws:` socket at all — browsers block it as mixed
 * content, and the failure is the same silent 1006 as everything else here.
 */
export function socketUrl(channel: WsChannel, base?: { protocol: string; host: string }): string {
  const origin = base ?? (import.meta.client ? window.location : { protocol: 'http:', host: '' })
  const scheme = origin.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${scheme}//${origin.host}/api/ws/${channel}`
}

/** Parses a server frame, dropping anything that is not one. */
export function parseServerFrame(data: unknown): WsServerFrame | null {
  if (typeof data !== 'string') return null

  let parsed: unknown
  try {
    parsed = JSON.parse(data)
  } catch {
    return null
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const type = (parsed as { type?: unknown }).type

  return type === 'welcome' ||
    type === 'pong' ||
    type === 'echoed' ||
    type === 'identity' ||
    type === 'error'
    ? (parsed as WsServerFrame)
    : null
}

/**
 * Turns a close code into something worth showing a person.
 *
 * 1006 is the one that matters and the one that says least: it is what the
 * browser reports for a refused handshake, a killed process, a proxy timeout and
 * a lost network alike, because no close frame was exchanged. The message says
 * so rather than pretending to know.
 */
export function describeClose(code: number, reason: string): string {
  if (code === WsCloseCode.Normal) return 'Closed.'
  if (code === WsCloseCode.SessionRevoked) return 'Your session ended. Sign in again.'
  if (code === WsCloseCode.ProtocolError) return `The server rejected a frame: ${reason}`
  if (code === WsCloseCode.MessageTooLarge) return 'That message was too large.'
  if (code === 1006) {
    return 'The connection dropped without a close frame — a refused handshake, a restart, or an idle timeout.'
  }
  return reason === '' ? `Closed with code ${code}.` : `Closed with code ${code}: ${reason}`
}

function describeTicketFailure(cause: unknown): string {
  const status =
    (cause as { statusCode?: number; status?: number } | null)?.statusCode ??
    (cause as { status?: number } | null)?.status

  if (status === 401) return 'You are not signed in.'
  if (status === 409) return 'This session cannot open a socket. Sign in again.'
  return 'Could not get a connection ticket.'
}

async function defaultFetchTicket(channel: WsChannel): Promise<WsTicketResponse> {
  const response = await $fetch<ApiResponse<WsTicketResponse>>('/api/ws/ticket', {
    method: 'POST',
    body: { channel },
  })
  return response.data
}

function defaultCreateSocket(url: string, protocols: string[]): WebSocketLike {
  return new WebSocket(url, protocols) as unknown as WebSocketLike
}

function defaultScheduler(fn: () => void, ms: number): () => void {
  const timer = setTimeout(fn, ms)
  return () => clearTimeout(timer)
}
