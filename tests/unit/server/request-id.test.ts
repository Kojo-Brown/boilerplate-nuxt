import { describe, it, expect } from 'vitest'

import {
  isSafeRequestId,
  REQUEST_ID_HEADERS,
  RESPONSE_REQUEST_ID_HEADER,
} from '~/server/utils/request-id'

describe('isSafeRequestId', () => {
  it('accepts the id formats a real caller sends', () => {
    expect(isSafeRequestId(crypto.randomUUID())).toBe(true)
    expect(isSafeRequestId('01JBX3M8Q0RZ4T7WB6C9D0EFGH')).toBe(true) // ULID
    expect(isSafeRequestId('trace-abc_123.4')).toBe(true)
    expect(isSafeRequestId('a'.repeat(128))).toBe(true)
  })

  it('rejects anything that could break out of a header or a log line', () => {
    // The reason this function exists: the value is echoed into a response
    // header and, in any real deployment, into the log stream.
    expect(isSafeRequestId('abc\r\nSet-Cookie: session=stolen')).toBe(false)
    expect(isSafeRequestId('abcdefgh\ninjected log line')).toBe(false)
    expect(isSafeRequestId('has spaces here')).toBe(false)
    expect(isSafeRequestId('semi;colon')).toBe(false)
    expect(isSafeRequestId('<script>alert(1)</script>')).toBe(false)
  })

  it('rejects lengths outside the accepted band', () => {
    expect(isSafeRequestId('short')).toBe(false)
    expect(isSafeRequestId('a'.repeat(129))).toBe(false)
    expect(isSafeRequestId('')).toBe(false)
  })

  it('rejects a missing value', () => {
    expect(isSafeRequestId(undefined)).toBe(false)
    expect(isSafeRequestId(null)).toBe(false)
  })
})

describe('header names', () => {
  it('prefers x-request-id but still accepts the id utils/api.ts already sends', () => {
    // `utils/api.ts` has been stamping `x-correlation-id` on every browser call
    // since the API-client item; dropping it would throw that away.
    expect(REQUEST_ID_HEADERS).toEqual(['x-request-id', 'x-correlation-id'])
    expect(RESPONSE_REQUEST_ID_HEADER).toBe('x-request-id')
  })
})
