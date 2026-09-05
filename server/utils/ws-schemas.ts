import { z } from 'zod'

import { WS_CHANNELS } from '~/types/websocket'

/**
 * The body `POST /api/ws/ticket` accepts.
 *
 * One field, and it is an enum rather than a string on purpose: the value
 * becomes the ticket's `aud` claim, which is what stops a ticket for one channel
 * opening another. A free-form channel would let a caller mint tickets for
 * routes that do not exist yet — harmless today, and exactly the kind of thing
 * that stops being harmless the moment a channel is added with a different
 * authorisation rule.
 *
 * `z.enum` over a `readonly` tuple keeps `WS_CHANNELS` in `types/websocket.ts`
 * the single list, so adding a channel there is the only edit needed here.
 */
export const wsTicketRequestSchema = z.object({
  channel: z.enum(WS_CHANNELS),
})

export type WsTicketRequest = z.infer<typeof wsTicketRequestSchema>
