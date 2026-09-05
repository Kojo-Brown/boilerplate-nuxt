import { effectScope, nextTick } from 'vue'
import { describe, it, expect, beforeEach, vi } from 'vitest'

import {
  describeClose,
  parseServerFrame,
  socketUrl,
  useWsChannel,
  BASE_BACKOFF_MS,
  MAX_RECONNECT_ATTEMPTS,
  type UseWsChannelOptions,
  type UseWsChannelReturn,
  type WebSocketLike,
} from '~/composables/useWsChannel'
import { WsCloseCode, type WsServerFrame, type WsTicketResponse } from '~/types/websocket'

/**
 * The socket is a fake, and it has to be: `WebSocket` is not constructible
 * without a server, and everything worth testing here is about what happens
 * *around* the connection — a fresh ticket per attempt, backoff that does not
 * retry a dead session, a superseded connection that cannot report its own close
 * as the state of its replacement.
 *
 * What is not faked is the frame parsing or the close-code vocabulary, which are
 * pure functions tested against the real ones the server emits.
 */
class FakeSocket implements WebSocketLike {
  readyState = 1
  readonly sent: string[] = []
  // Not `{ code?: number }`: under `exactOptionalPropertyTypes` an absent
  // property and one set to `undefined` are different types, and `close()`'s
  // arguments arrive as the latter.
  readonly closes: Array<{ code: number | undefined; reason: string | undefined }> = []
  private readonly listeners = new Map<string, Array<(event: never) => void>>()

  constructor(
    readonly url: string,
    readonly protocols: string[],
  ) {}

  send(data: string): void {
    this.sent.push(data)
  }

  close(code?: number, reason?: string): void {
    this.closes.push({ code, reason })
  }

  addEventListener(type: string, listener: (event: never) => void): void {
    const existing = this.listeners.get(type) ?? []
    existing.push(listener)
    this.listeners.set(type, existing)
  }

  emit(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event as never)
  }

  /** The server's opening frame — what actually means "authenticated". */
  welcome(overrides: Partial<Extract<WsServerFrame, { type: 'welcome' }>> = {}): void {
    this.emit('message', {
      data: JSON.stringify({
        type: 'welcome',
        peerId: 'peer-1',
        channel: 'echo',
        userId: 'user-1',
        connectedAt: 1_800_000_000_000,
        sessionExpiresAt: 1_800_003_600_000,
        ...overrides,
      }),
    })
  }
}

const TICKET: WsTicketResponse = {
  token: 'mock-ticket-token',
  channel: 'echo',
  expiresAt: 1_800_000_030_000,
  subprotocol: 'nuxt.ws.ticket.v1',
}

/** A scheduler that records pending callbacks instead of waiting for a clock. */
function createScheduler() {
  const pending: Array<{ fn: () => void; ms: number; cancelled: boolean }> = []
  return {
    pending,
    schedule(fn: () => void, ms: number): () => void {
      const entry = { fn, ms, cancelled: false }
      pending.push(entry)
      return () => {
        entry.cancelled = true
      }
    },
    /** Runs the most recent live callback. */
    async flush(): Promise<void> {
      const entry = [...pending].reverse().find((p) => !p.cancelled)
      if (entry === undefined) return
      entry.cancelled = true
      entry.fn()
      await nextTick()
      await Promise.resolve()
    },
  }
}

let sockets: FakeSocket[]
let fetchTicket: ReturnType<typeof vi.fn>
let scheduler: ReturnType<typeof createScheduler>

beforeEach(() => {
  sockets = []
  fetchTicket = vi.fn(async () => TICKET)
  scheduler = createScheduler()
})

function setup(options: UseWsChannelOptions = {}): UseWsChannelReturn {
  return useWsChannel('echo', {
    createSocket: (url, protocols) => {
      const socket = new FakeSocket(url, protocols)
      sockets.push(socket)
      return socket
    },
    fetchTicket: fetchTicket as unknown as (channel: 'echo') => Promise<WsTicketResponse>,
    scheduler: scheduler.schedule,
    keepaliveMs: 0,
    ...options,
  })
}

const last = (): FakeSocket => sockets[sockets.length - 1]!

describe('socketUrl', () => {
  it('derives the scheme from the page, because a https page cannot open ws:', () => {
    expect(socketUrl('echo', { protocol: 'https:', host: 'app.test' })).toBe(
      'wss://app.test/api/ws/echo',
    )
    expect(socketUrl('echo', { protocol: 'http:', host: 'localhost:3000' })).toBe(
      'ws://localhost:3000/api/ws/echo',
    )
  })
})

describe('parseServerFrame', () => {
  it('accepts every frame the server sends', () => {
    expect(parseServerFrame('{"type":"pong","at":1}')).toEqual({ type: 'pong', at: 1 })
    expect(parseServerFrame('{"type":"echoed","text":"hi","seq":1}')).toMatchObject({
      type: 'echoed',
    })
  })

  it.each([
    ['a binary payload', new ArrayBuffer(4)],
    ['not JSON', 'hello'],
    ['an array', '[1,2]'],
    ['null', 'null'],
    ['an unknown type', '{"type":"surprise"}'],
  ])('drops %s', (_label, data) => {
    expect(parseServerFrame(data)).toBeNull()
  })
})

describe('describeClose', () => {
  it('says what 1006 actually means rather than pretending to know', () => {
    // The browser reports 1006 for a refused handshake, a killed process, a
    // proxy timeout and a lost network alike — no close frame was exchanged.
    expect(describeClose(1006, '')).toMatch(/without a close frame/)
  })

  it('names the codes the server defines', () => {
    expect(describeClose(WsCloseCode.SessionRevoked, '')).toMatch(/session ended/i)
    expect(describeClose(WsCloseCode.MessageTooLarge, '')).toMatch(/too large/i)
    expect(describeClose(WsCloseCode.ProtocolError, 'bad frame')).toContain('bad frame')
    expect(describeClose(WsCloseCode.Normal, '')).toBe('Closed.')
  })

  it('falls back to the raw code for anything it does not know', () => {
    expect(describeClose(1011, '')).toBe('Closed with code 1011.')
    expect(describeClose(1011, 'internal error')).toBe('Closed with code 1011: internal error')
  })
})

describe('useWsChannel', () => {
  it('fetches a ticket and offers it after the marker subprotocol', async () => {
    const channel = setup()
    await channel.connect()

    expect(fetchTicket).toHaveBeenCalledWith('echo')
    // Marker first: the server selects the first protocol offered, and echoing
    // the token back would put the credential in the response.
    expect(last().protocols).toEqual(['nuxt.ws.ticket.v1', 'mock-ticket-token'])
  })

  it('is connected only once the welcome frame arrives, not on open', async () => {
    const channel = setup()
    await channel.connect()

    // A 101 proves the handshake finished and nothing about who the server
    // resolved. `onopen` is not authentication.
    expect(channel.status.value).toBe('connecting')

    last().welcome()
    await nextTick()

    expect(channel.status.value).toBe('connected')
    expect(channel.identity.value).toMatchObject({ userId: 'user-1', peerId: 'peer-1' })
  })

  it('refuses to send before the welcome, and sends after it', async () => {
    const channel = setup()
    await channel.connect()

    expect(channel.send({ type: 'echo', text: 'early' })).toBe(false)

    last().welcome()
    await nextTick()

    expect(channel.send({ type: 'echo', text: 'hi' })).toBe(true)
    expect(JSON.parse(last().sent[0]!)).toEqual({ type: 'echo', text: 'hi' })
  })

  it('collects frames and caps the history', async () => {
    const channel = setup({ historyLimit: 3 })
    await channel.connect()
    last().welcome()

    for (let seq = 1; seq <= 4; seq++) {
      last().emit('message', { data: JSON.stringify({ type: 'echoed', text: `m${seq}`, seq }) })
    }
    await nextTick()

    expect(channel.frames.value).toHaveLength(3)
    expect(channel.frames.value.at(-1)).toMatchObject({ seq: 4 })
  })

  it('fetches a fresh ticket for every reconnect', async () => {
    // The single most common way to break this endpoint: a ticket is spent on
    // first use, so a cached one fails as `ticket-replayed` on the second
    // connect — and the reason never reaches the client.
    const channel = setup()
    await channel.connect()
    last().welcome()
    await nextTick()

    last().emit('close', { code: 1006, reason: '' })
    await nextTick()
    await scheduler.flush()

    expect(fetchTicket).toHaveBeenCalledTimes(2)
    expect(sockets).toHaveLength(2)
  })

  it('backs off exponentially between attempts', async () => {
    const channel = setup()
    await channel.connect()
    last().emit('close', { code: 1006, reason: '' })
    await nextTick()

    const first = scheduler.pending.at(-1)!.ms
    await scheduler.flush()
    last().emit('close', { code: 1006, reason: '' })
    await nextTick()

    expect(first).toBe(BASE_BACKOFF_MS)
    expect(scheduler.pending.at(-1)!.ms).toBe(BASE_BACKOFF_MS * 2)
    expect(channel.attempts.value).toBe(2)
  })

  it('does not retry a session that ended — that is a loop against a wall', async () => {
    const channel = setup()
    await channel.connect()
    last().welcome()
    await nextTick()

    last().emit('close', { code: WsCloseCode.SessionRevoked, reason: 'session expired' })
    await nextTick()

    expect(channel.status.value).toBe('error')
    expect(scheduler.pending.filter((p) => !p.cancelled)).toHaveLength(0)
  })

  it('gives up after the attempt limit rather than reconnecting forever', async () => {
    const channel = setup()
    await channel.connect()

    for (let i = 0; i <= MAX_RECONNECT_ATTEMPTS; i++) {
      last().emit('close', { code: 1006, reason: '' })
      await nextTick()
      await scheduler.flush()
    }

    expect(channel.status.value).toBe('error')
    expect(channel.error.value).toMatch(/Gave up after/)
  })

  it('resets the backoff when a connection is actually authenticated', async () => {
    const channel = setup()
    await channel.connect()
    last().emit('close', { code: 1006, reason: '' })
    await nextTick()
    await scheduler.flush()

    expect(channel.attempts.value).toBe(1)

    last().welcome()
    await nextTick()

    expect(channel.attempts.value).toBe(0)
  })

  it('reports a ticket route that says 401 in words the socket never could', async () => {
    fetchTicket.mockRejectedValueOnce({ statusCode: 401 })
    const channel = setup({ autoReconnect: false })

    await channel.connect()

    expect(channel.status.value).toBe('error')
    expect(channel.error.value).toBe('You are not signed in.')
    expect(sockets).toHaveLength(0)
  })

  it('does not open a second socket while one is connecting', async () => {
    const channel = setup()
    await Promise.all([channel.connect(), channel.connect()])
    expect(sockets).toHaveLength(1)
  })

  it('closes deliberately without reconnecting', async () => {
    const channel = setup()
    await channel.connect()
    last().welcome()
    await nextTick()

    channel.disconnect()

    expect(last().closes).toEqual([{ code: WsCloseCode.Normal, reason: 'client closed' }])
    expect(channel.status.value).toBe('idle')
    expect(scheduler.pending.filter((p) => !p.cancelled)).toHaveLength(0)
  })

  it('ignores a superseded socket reporting its own close', async () => {
    // An old socket still fires `close` after `disconnect()` replaced the
    // generation. Without the guard it would set `closed` over the new state —
    // the superseded-run bug `useNdjsonStream` documents.
    const channel = setup()
    await channel.connect()
    const stale = last()
    last().welcome()
    await nextTick()

    channel.disconnect()
    stale.emit('close', { code: 1006, reason: '' })
    await nextTick()

    expect(channel.status.value).toBe('idle')
    expect(channel.error.value).toBeNull()
  })

  it('sends an application-level keepalive, which is the only kind a browser can', async () => {
    const channel = setup({ keepaliveMs: 25_000 })
    await channel.connect()
    last().welcome()
    await nextTick()

    await scheduler.flush()

    expect(JSON.parse(last().sent.at(-1)!)).toEqual({ type: 'ping' })
  })

  it('disconnects when its effect scope is disposed', async () => {
    const scope = effectScope()
    let channel!: UseWsChannelReturn
    scope.run(() => {
      channel = setup()
    })
    await channel.connect()
    last().welcome()
    await nextTick()

    scope.stop()

    expect(last().closes).toHaveLength(1)
  })

  it('reports a socket constructor that throws, as a https page opening ws: does', async () => {
    // Mixed content: a page on `https:` may not open a `ws:` socket, and the
    // browser throws from the constructor rather than failing the handshake.
    const channel = useWsChannel('echo', {
      createSocket: () => {
        throw new Error('Insecure WebSocket from a secure page')
      },
      fetchTicket: async () => TICKET,
      scheduler: scheduler.schedule,
      keepaliveMs: 0,
      autoReconnect: false,
    })

    await channel.connect()

    expect(channel.status.value).toBe('error')
    expect(channel.error.value).toBe('Insecure WebSocket from a secure page')
  })

  it('does not overwrite the close message with the error event that precedes it', async () => {
    // A refused upgrade fires `error` with no status and no reason, then `close`
    // with 1006 — the useful one. The error handler only fills a gap.
    const channel = setup({ autoReconnect: false })
    await channel.connect()

    last().emit('error', {})
    expect(channel.error.value).toBe('The connection failed.')

    last().emit('close', { code: 1006, reason: '' })
    await nextTick()

    expect(channel.error.value).toMatch(/without a close frame/)
  })

  it.each([
    [409, 'This session cannot open a socket. Sign in again.'],
    [500, 'Could not get a connection ticket.'],
  ])('explains a ticket route that answered %s', async (statusCode, message) => {
    fetchTicket.mockRejectedValueOnce({ statusCode })
    const channel = setup({ autoReconnect: false })

    await channel.connect()

    expect(channel.error.value).toBe(message)
  })

  it('reads a status off either property name an HTTP client might use', async () => {
    fetchTicket.mockRejectedValueOnce({ status: 401 })
    const channel = setup({ autoReconnect: false })

    await channel.connect()

    expect(channel.error.value).toBe('You are not signed in.')
  })

  it('schedules its own reconnect when no scheduler is injected', async () => {
    vi.useFakeTimers()
    try {
      const channel = useWsChannel('echo', {
        createSocket: (url, protocols) => {
          const socket = new FakeSocket(url, protocols)
          sockets.push(socket)
          return socket
        },
        fetchTicket: async () => TICKET,
        keepaliveMs: 0,
      })

      await channel.connect()
      last().emit('close', { code: 1006, reason: '' })
      await nextTick()

      await vi.advanceTimersByTimeAsync(BASE_BACKOFF_MS)
      await vi.advanceTimersByTimeAsync(0)

      expect(sockets).toHaveLength(2)
      channel.disconnect()
    } finally {
      vi.useRealTimers()
    }
  })

  it('surfaces a server error frame without dropping the connection', async () => {
    const channel = setup()
    await channel.connect()
    last().welcome()
    last().emit('message', { data: JSON.stringify({ type: 'error', message: 'unknown frame' }) })
    await nextTick()

    expect(channel.error.value).toBe('unknown frame')
    expect(channel.status.value).toBe('connected')
  })
})
