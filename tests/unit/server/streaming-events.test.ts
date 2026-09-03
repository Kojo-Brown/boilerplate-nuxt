import { describe, it, expect } from 'vitest'

import { parseResumeAfter, readEventsQuery } from '~/server/api/streaming/events.get'
import { MAX_RESUME_TOKEN_LENGTH } from '~/server/utils/sse'

/**
 * The query reader is a pure function of the parsed query and the resume token
 * for the same reason `readFeedQuery` is: the clamps are the only thing standing
 * between a query string and a connection that is unbounded in size and time,
 * and that is worth an assertion rather than a reading of the code.
 *
 * It matters more here than on the NDJSON feed. `EventSource` reconnects by
 * itself, so an endpoint that can be made expensive can be made expensive
 * repeatedly without the caller doing anything after the first request.
 */

describe('readEventsQuery', () => {
  it('uses the demo defaults for an empty query', () => {
    expect(readEventsQuery({}, null)).toEqual({
      count: 10,
      delayMs: 500,
      heartbeatMs: 2_000,
      failAt: null,
      dropAt: null,
      resumeAfter: null,
    })
  })

  it('reads the supported flags', () => {
    expect(
      readEventsQuery(
        { count: '5', delay: '10', heartbeat: '250', failAt: '3', dropAt: '4' },
        null,
      ),
    ).toMatchObject({ count: 5, delayMs: 10, heartbeatMs: 250, failAt: 3, dropAt: 4 })
  })

  it('clamps an absurd count to a bounded connection', () => {
    expect(readEventsQuery({ count: '1000000' }, null).count).toBe(100)
    expect(readEventsQuery({ count: '0' }, null).count).toBe(1)
  })

  it('clamps the delay from both sides', () => {
    expect(readEventsQuery({ delay: '999999' }, null).delayMs).toBe(2_000)
    expect(readEventsQuery({ delay: '-5' }, null).delayMs).toBe(0)
  })

  it('floors the heartbeat, because a 1ms keepalive is a busy loop on a socket', () => {
    expect(readEventsQuery({ heartbeat: '1' }, null).heartbeatMs).toBe(100)
    expect(readEventsQuery({ heartbeat: '999999' }, null).heartbeatMs).toBe(60_000)
  })

  it.each([
    ['absent', undefined],
    ['empty', ''],
    ['unparseable', 'soon'],
  ])('treats a %s failAt as "do not fail"', (_label, value) => {
    expect(readEventsQuery({ failAt: value }, null).failAt).toBeNull()
  })

  it('leaves failAt and dropAt unclamped so they stay reachable after a resume', () => {
    // After resuming at 500 the live range is 501…510, so clamping these to
    // 1…count would make both flags silently unreachable on every reconnect —
    // which is exactly the request they exist to be used on.
    const query = readEventsQuery({ failAt: '505', dropAt: '507' }, '500')

    expect(query).toMatchObject({ failAt: 505, dropAt: 507, resumeAfter: 500 })
  })
})

describe('parseResumeAfter', () => {
  it('reads the sequence number the client last saw', () => {
    expect(parseResumeAfter('42')).toBe(42)
  })

  it('is null for a fresh connection', () => {
    expect(parseResumeAfter(null)).toBeNull()
  })

  it.each([
    ['a token from some other endpoint', 'cursor:abc'],
    ['a negative', '-1'],
    ['a decimal', '4.5'],
    ['whitespace', '  '],
  ])('resumes from the beginning for %s', (_label, value) => {
    // Losing the client's position is recoverable; inventing one is not.
    expect(parseResumeAfter(value)).toBeNull()
  })

  it('rejects an id past the safe integer range', () => {
    // `/^\d+$/` admits these, and at that magnitude `seq + 1` is not a distinct
    // number — the emitting loop would never advance.
    expect(parseResumeAfter('9007199254740993')).toBeNull()
  })

  it('rejects an over-long token before it reaches an id line', () => {
    expect(parseResumeAfter('1'.repeat(MAX_RESUME_TOKEN_LENGTH + 1))).toBeNull()
  })
})
