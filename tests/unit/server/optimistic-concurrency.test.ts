import { describe, expect, it } from 'vitest'

import {
  conflictBody,
  conflictMessage,
  decidePrecondition,
  parseIfMatch,
  versionETag,
} from '~/server/utils/optimistic-concurrency'

/**
 * The rules half of optimistic concurrency, driven as plain functions.
 *
 * There is no Nitro, no database and no event here, which is the point of the
 * split: everything in this file is a decision about a header, and a decision is
 * worth testing at the altitude it is made at. The half that has to be true
 * *about SQL* is `todo-store.test.ts`.
 */

describe('versionETag', () => {
  it('quotes the version, because an unquoted tag is not an entity tag', () => {
    expect(versionETag(4)).toBe('"4"')
  })

  it('emits a strong tag — If-Match is a strong comparison', () => {
    expect(versionETag(1).startsWith('W/')).toBe(false)
  })
})

describe('parseIfMatch', () => {
  it('reports an absent header as absent rather than as a failure', () => {
    expect(parseIfMatch(undefined)).toEqual({ kind: 'absent' })
  })

  it('reads a single tag', () => {
    expect(parseIfMatch('"4"')).toEqual({ kind: 'versions', versions: [4] })
  })

  it('reads a list, which RFC 9110 allows and a retrying client uses', () => {
    expect(parseIfMatch('"3", "4"')).toEqual({ kind: 'versions', versions: [3, 4] })
  })

  it('tolerates the whitespace a hand-written client produces', () => {
    expect(parseIfMatch('  "3" ,"4"  ')).toEqual({ kind: 'versions', versions: [3, 4] })
  })

  it('accepts version 0, which is a legal counter value', () => {
    expect(parseIfMatch('"0"')).toEqual({ kind: 'versions', versions: [0] })
  })

  it('reads * as "any version, as long as it exists"', () => {
    expect(parseIfMatch('*')).toEqual({ kind: 'any' })
  })

  it.each([
    ['4', 'an unquoted value'],
    ['W/"4"', 'a weak tag, which If-Match does not compare'],
    ['"v4"', 'a tag body that is not a version'],
    ['"4"extra', 'trailing junk after the tag'],
    ['""', 'an empty tag body'],
    ['"-1"', 'a negative version'],
    ['"04"', 'a zero-padded version, which is a second spelling of 4'],
    ['"1e3"', 'an exponent'],
    ['   ', 'an empty header'],
    ['"3",', 'an empty entry in the list'],
  ])('rejects %j — %s', (header) => {
    const result = parseIfMatch(header)

    expect(result.kind).toBe('malformed')
    // The reason reaches the client in a 400 body, so it has to say something.
    expect(result.kind === 'malformed' && result.reason.length).toBeGreaterThan(0)
  })

  it('rejects rather than dropping the bad tag out of a list', () => {
    // Dropping it would leave `"4"` as the precondition and the client would
    // never learn that half of what it sent was ignored.
    expect(parseIfMatch('"4", "v5"').kind).toBe('malformed')
  })
})

describe('decidePrecondition', () => {
  it('demands a precondition on a route that requires one', () => {
    expect(decidePrecondition(undefined, { required: true })).toEqual({ kind: 'required' })
  })

  it('lets an unconditional write through where one is allowed', () => {
    expect(decidePrecondition(undefined, { required: false })).toEqual({
      kind: 'proceed',
      expected: null,
    })
  })

  it('passes a malformed header through as malformed, never as absent', () => {
    // The distinction is the whole safety property: a header the server could
    // not read must not become a write with no guard at all.
    const decision = decidePrecondition('W/"4"', { required: true })

    expect(decision.kind).toBe('malformed')
  })

  it('turns a single tag into the version to guard on', () => {
    expect(decidePrecondition('"7"', { required: true })).toEqual({ kind: 'proceed', expected: 7 })
  })

  it('drops the version predicate for *, which asks only that the row exist', () => {
    expect(decidePrecondition('*', { required: true })).toEqual({ kind: 'proceed', expected: null })
  })

  it('guards on the highest version in a list, so no write can be lost', () => {
    // Guarding on 3 would let a client that sent `"3", "4"` overwrite version 4
    // while believing it held 3.
    expect(decidePrecondition('"4", "3"', { required: true })).toEqual({
      kind: 'proceed',
      expected: 4,
    })
  })
})

describe('conflictBody', () => {
  const row = { id: 'todo-1', version: 5 }

  it('carries the current row and both versions for a stale write', () => {
    expect(conflictBody({ kind: 'stale', actual: 5 }, row, 4)).toEqual({
      current: row,
      expected: 4,
      actual: 5,
    })
  })

  it('reports a deleted row as null on every field that describes it', () => {
    // Not "current: the row we happened to read": there is no row, and a client
    // that saw one here would render a todo that does not exist.
    expect(conflictBody({ kind: 'missing' }, null, 4)).toEqual({
      current: null,
      expected: 4,
      actual: null,
    })
  })

  it('ignores a row handed in alongside a missing verdict', () => {
    expect(conflictBody({ kind: 'missing' }, row, 4).current).toBeNull()
  })
})

describe('conflictMessage', () => {
  it('names both versions, so the message is actionable on its own', () => {
    const message = conflictMessage({ kind: 'stale', actual: 5 }, 4)

    expect(message).toContain('version 4')
    expect(message).toContain('version 5')
  })

  it('says the todo is gone when it is, rather than naming a version', () => {
    expect(conflictMessage({ kind: 'missing' }, 4)).toMatch(/no longer exists/i)
  })

  it('does not print "null" when the precondition was *', () => {
    expect(conflictMessage({ kind: 'stale', actual: 5 }, null)).not.toContain('null')
  })
})
