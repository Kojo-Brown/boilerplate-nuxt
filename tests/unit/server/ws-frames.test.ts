import { describe, it, expect } from 'vitest'

import { frameByteLength, isFrameWithinLimit, parseClientFrame } from '~/server/utils/ws-frames'
import { WS_MAX_FRAME_BYTES } from '~/types/websocket'

describe('parseClientFrame', () => {
  it('parses each frame the protocol defines', () => {
    expect(parseClientFrame('{"type":"ping"}')).toEqual({ type: 'ping' })
    expect(parseClientFrame('{"type":"ping","nonce":"n1"}')).toEqual({ type: 'ping', nonce: 'n1' })
    expect(parseClientFrame('{"type":"echo","text":"hi"}')).toEqual({ type: 'echo', text: 'hi' })
    expect(parseClientFrame('{"type":"whoami"}')).toEqual({ type: 'whoami' })
  })

  it('accepts an empty echo, which is a message and not an omission', () => {
    expect(parseClientFrame('{"type":"echo","text":""}')).toEqual({ type: 'echo', text: '' })
  })

  it('rejects a known type whose payload is missing or the wrong shape', () => {
    // The bug this stops: `{"type":"echo"}` reaching the echo branch and sending
    // `JSON.stringify({text: undefined})` back — a frame with the field silently
    // absent, which looks delivered and is not.
    expect(parseClientFrame('{"type":"echo"}')).toBeNull()
    expect(parseClientFrame('{"type":"echo","text":42}')).toBeNull()
    expect(parseClientFrame('{"type":"echo","text":null}')).toBeNull()
    expect(parseClientFrame('{"type":"ping","nonce":7}')).toBeNull()
  })

  it('drops fields it does not know rather than passing them through', () => {
    expect(parseClientFrame('{"type":"echo","text":"hi","admin":true}')).toEqual({
      type: 'echo',
      text: 'hi',
    })
  })

  it.each([
    ['not JSON', 'hello'],
    ['a bare string', '"hello"'],
    ['a number', '42'],
    ['null', 'null'],
    ['an empty frame', ''],
    ['an unknown type', '{"type":"drop-tables"}'],
    ['no type at all', '{"text":"hi"}'],
  ])('returns null for %s', (_label, text) => {
    expect(parseClientFrame(text)).toBeNull()
  })

  it('rejects an array, which typeof calls an object', () => {
    // `['echo']` would otherwise reach the switch with `frame['type']`
    // undefined and land on `default` by luck rather than by a check.
    expect(parseClientFrame('["echo"]')).toBeNull()
    expect(parseClientFrame('[{"type":"whoami"}]')).toBeNull()
  })

  it('does not treat a prototype-polluting key as a type', () => {
    expect(parseClientFrame('{"__proto__":{"type":"whoami"}}')).toBeNull()
    expect(parseClientFrame('{"constructor":{"type":"whoami"}}')).toBeNull()
  })
})

describe('frameByteLength', () => {
  it('counts UTF-8 bytes, not UTF-16 code units', () => {
    // `String#length` says 1 for "é" and 2 for an emoji, which would let a frame
    // through at up to four times the cap.
    expect(frameByteLength('é')).toBe(2)
    expect(frameByteLength('漢')).toBe(3)
    expect(frameByteLength('🙂')).toBe(4)
    expect('🙂'.length).toBe(2)
  })
})

describe('isFrameWithinLimit', () => {
  it('admits a frame exactly at the limit and refuses one byte past it', () => {
    expect(isFrameWithinLimit('a'.repeat(WS_MAX_FRAME_BYTES))).toBe(true)
    expect(isFrameWithinLimit('a'.repeat(WS_MAX_FRAME_BYTES + 1))).toBe(false)
  })

  it('measures multi-byte text by its bytes', () => {
    // Half the cap in characters, four times over it in bytes.
    expect(isFrameWithinLimit('🙂'.repeat(WS_MAX_FRAME_BYTES / 2))).toBe(false)
  })
})
