import { describe, it, expect } from 'vitest'

import { normalisePathname } from '~/server/utils/request-path'

/**
 * These are the cases the access policy's correctness rests on. A rule that
 * protects `/api/todos` is only worth what this function is worth: if a request
 * can be spelled so that the policy sees one path and the router resolves
 * another, the rule is decoration.
 */
describe('normalisePathname', () => {
  it('leaves an already-canonical path alone', () => {
    expect(normalisePathname('/api/todos')).toBe('/api/todos')
    expect(normalisePathname('/')).toBe('/')
  })

  it('drops the query string and the fragment', () => {
    expect(normalisePathname('/api/todos?page=2&limit=10')).toBe('/api/todos')
    expect(normalisePathname('/api/todos#section')).toBe('/api/todos')
    expect(normalisePathname('/api/todos?next=/api/route-rules/swr')).toBe('/api/todos')
  })

  it('removes a trailing slash and collapses repeated ones', () => {
    expect(normalisePathname('/api/todos/')).toBe('/api/todos')
    expect(normalisePathname('//api//todos//')).toBe('/api/todos')
    expect(normalisePathname('')).toBe('/')
    expect(normalisePathname('///')).toBe('/')
  })

  it('drops `.` segments and pops the parent on `..`', () => {
    expect(normalisePathname('/api/./todos')).toBe('/api/todos')
    expect(normalisePathname('/api/route-rules/../todos')).toBe('/api/todos')
    expect(normalisePathname('/api/a/b/../../todos')).toBe('/api/todos')
  })

  it('never climbs above the root', () => {
    expect(normalisePathname('/../../etc/passwd')).toBe('/etc/passwd')
    expect(normalisePathname('/..')).toBe('/')
  })

  // The three that matter. Each one, left undecoded, reads as a path under the
  // public `/api/route-rules` prefix while resolving into the protected
  // `/api/todos`.
  it.each([
    ['single-encoded', '/api/route-rules/%2e%2e/todos'],
    ['upper-case escape', '/api/route-rules/%2E%2E/todos'],
    ['double-encoded', '/api/route-rules/%252e%252e/todos'],
  ])('resolves a %s traversal to the path it actually reaches', (_label, path) => {
    expect(normalisePathname(path)).toBe('/api/todos')
  })

  it('still normalises when decoding uses up every pass', () => {
    // Triple-encoded: three decode rounds, which is exactly MAX_DECODE_PASSES.
    // The loop exits on the pass limit rather than on a stable value, so this is
    // the branch where the fixed point is never actually observed.
    expect(normalisePathname('/api/route-rules/%25252e%25252e/todos')).toBe('/api/todos')
  })

  it('decodes an encoded separator rather than treating it as a segment', () => {
    expect(normalisePathname('/api%2Ftodos')).toBe('/api/todos')
  })

  it('falls back to the raw value on a malformed escape instead of throwing', () => {
    // `decodeURIComponent('%zz')` throws — a malformed path must still produce a
    // path to match, and matching the raw form is the conservative choice.
    expect(() => normalisePathname('/api/%zz/todos')).not.toThrow()
    expect(normalisePathname('/api/%zz/todos')).toBe('/api/%zz/todos')
  })

  it('always returns a rooted path', () => {
    for (const input of ['api/todos', '/api/todos', '', '.', './api']) {
      expect(normalisePathname(input).startsWith('/')).toBe(true)
    }
  })
})
