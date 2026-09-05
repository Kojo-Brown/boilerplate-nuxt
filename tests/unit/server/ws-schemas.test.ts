import { describe, it, expect, vi, afterEach } from 'vitest'

import { wsTicketRequestSchema } from '~/server/utils/ws-schemas'
import { useWsTicketStore } from '~/server/utils/ws-ticket'
import { SESSIONS_BASE } from '~/server/utils/storage'
import { WS_CHANNELS } from '~/types/websocket'

describe('wsTicketRequestSchema', () => {
  it('accepts every channel the app defines', () => {
    for (const channel of WS_CHANNELS) {
      expect(wsTicketRequestSchema.safeParse({ channel }).success).toBe(true)
    }
  })

  it('refuses a channel that does not exist', () => {
    // The value becomes the ticket's `aud`, so an open string would let a caller
    // mint tickets for routes that do not exist yet — harmless until a channel
    // is added with a different authorisation rule.
    expect(wsTicketRequestSchema.safeParse({ channel: 'chat' }).success).toBe(false)
    expect(wsTicketRequestSchema.safeParse({ channel: '' }).success).toBe(false)
  })

  it.each([
    ['no body at all', undefined],
    ['an empty object', {}],
    ['a non-object', 'echo'],
    ['a channel of the wrong type', { channel: 1 }],
    ['null', null],
  ])('refuses %s', (_label, body) => {
    expect(wsTicketRequestSchema.safeParse(body).success).toBe(false)
  })
})

describe('useWsTicketStore', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('burns tickets on the sessions base, not the cache', () => {
    // `cache` entries can be evicted under memory pressure, and a replay guard
    // that can be evicted is not one. The base is also what an operator points
    // at Redis for revocation, which is the base a replay guard has to share.
    const useStorage = vi.fn(() => ({}) as never)
    vi.stubGlobal('useStorage', useStorage)

    useWsTicketStore()

    expect(useStorage).toHaveBeenCalledWith(SESSIONS_BASE)
  })
})
