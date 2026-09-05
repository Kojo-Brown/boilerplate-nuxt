import { WS_MAX_FRAME_BYTES, type WsClientFrame } from '~/types/websocket'

/**
 * Parsing and sizing the frames a client sends.
 *
 * Separate from `server/api/ws/echo.ts` for the reason `readEventsQuery` is
 * separate from its handler in `server/api/streaming/events.get.ts`: this is the
 * part that turns attacker-controlled bytes into a value the rest of the handler
 * trusts, and it should be exercisable without a socket, a peer, or Nitro's
 * auto-imports. It is also the part a second channel would reuse unchanged.
 */

/**
 * Parses one client frame, or `null` for anything this app does not speak.
 *
 * Every field is validated, not just `type`. `{"type":"echo"}` with no `text`
 * would otherwise reach the echo branch and send `undefined` back through
 * `JSON.stringify`, producing a frame with a missing field rather than an
 * error — the socket-shaped version of the `JSON.stringify(undefined)` trap
 * `sseBlocks` documents in `server/utils/sse.ts`.
 *
 * Arrays are rejected explicitly because `typeof [] === 'object'`, and a JSON
 * array would otherwise reach the `switch` with `frame['type']` as `undefined`
 * — landing on `default` by luck rather than by a check.
 */
export function parseClientFrame(text: string): WsClientFrame | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const frame = parsed as Record<string, unknown>

  switch (frame['type']) {
    case 'ping':
      if (frame['nonce'] === undefined) return { type: 'ping' }
      return typeof frame['nonce'] === 'string' ? { type: 'ping', nonce: frame['nonce'] } : null

    case 'echo':
      return typeof frame['text'] === 'string' ? { type: 'echo', text: frame['text'] } : null

    case 'whoami':
      return { type: 'whoami' }

    default:
      return null
  }
}

/**
 * UTF-8 length in bytes.
 *
 * `String#length` counts UTF-16 code units, which undercounts most of the world:
 * a cap of 16,384 "characters" is 49,152 bytes of CJK text and 65,536 bytes of
 * some emoji. The cap is about what the process has to hold, so bytes is the
 * unit it has to be measured in.
 */
export function frameByteLength(text: string): number {
  return new TextEncoder().encode(text).length
}

/** Whether a frame is within {@link WS_MAX_FRAME_BYTES}. */
export function isFrameWithinLimit(text: string): boolean {
  return frameByteLength(text) <= WS_MAX_FRAME_BYTES
}
