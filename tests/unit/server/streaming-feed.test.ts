import { describe, it, expect } from 'vitest'

import { readFeedQuery } from '~/server/api/streaming/feed.get'

/**
 * The clamps are the only thing between a query string and an unbounded
 * response: every record holds the connection open, and `sendStream` applies no
 * backpressure (see `server/utils/stream.ts`), so `?count=1000000` on an
 * unclamped route is a one-request way to make the process buffer.
 *
 * That makes them a security property rather than input tidying, which is why
 * they are asserted rather than read.
 */
describe('readFeedQuery', () => {
  it('defaults an empty query to a short, paced stream', () => {
    expect(readFeedQuery({})).toEqual({ count: 8, delayMs: 250, failAt: null })
  })

  it('accepts values inside the limits', () => {
    expect(readFeedQuery({ count: '3', delay: '10', failAt: '2' })).toEqual({
      count: 3,
      delayMs: 10,
      failAt: 2,
    })
  })

  it('clamps a count above the maximum instead of honouring it', () => {
    expect(readFeedQuery({ count: '1000000' }).count).toBe(50)
  })

  it('clamps a delay above the maximum, so one request cannot hold a socket open', () => {
    expect(readFeedQuery({ delay: '600000' }).delayMs).toBe(1000)
  })

  it('clamps values below the minimum', () => {
    expect(readFeedQuery({ count: '0', delay: '-5' })).toEqual({
      count: 1,
      delayMs: 0,
      failAt: null,
    })
  })

  it('truncates a fractional value rather than rejecting it', () => {
    expect(readFeedQuery({ count: '3.9' }).count).toBe(3)
  })

  it('falls back to the defaults for values that are not numbers', () => {
    for (const raw of ['', 'abc', 'NaN', 'Infinity']) {
      expect(readFeedQuery({ count: raw, delay: raw })).toEqual({
        count: 8,
        delayMs: 250,
        failAt: null,
      })
    }
  })

  it('treats an unusable failAt as "do not fail" rather than record zero', () => {
    // A number that fell back to 0 would never match a record id, but only by
    // accident. `null` says it out loud.
    for (const raw of [undefined, '', 'abc']) {
      expect(readFeedQuery({ failAt: raw }).failAt).toBeNull()
    }
  })

  it('ignores an array of repeated query values the same way', () => {
    // `?count=1&count=2` parses to an array, which `Number()` reads as NaN.
    expect(readFeedQuery({ count: ['1', '2'] }).count).toBe(8)
  })
})
