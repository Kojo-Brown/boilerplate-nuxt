import { describe, it, expect } from 'vitest'

import { createNdjsonParser, parseNdjson } from '~/utils/ndjson'

/**
 * The parser exists for one reason — a chunk boundary is not a line boundary —
 * so most of what is asserted here is the ways those two can fail to line up.
 */
interface Row {
  id: number
}

/** Feeds a document to a parser in fixed-size pieces, as a socket would. */
function readInChunks<T>(document: string, size: number): T[] {
  const parser = createNdjsonParser<T>()
  const records: T[] = []

  for (let offset = 0; offset < document.length; offset += size) {
    records.push(...parser.push(document.slice(offset, offset + size)))
  }
  records.push(...parser.flush())

  return records
}

const DOCUMENT = ['{"id":1}', '{"id":2}', '{"id":3}'].join('\n') + '\n'

describe('createNdjsonParser', () => {
  it('returns a record only once its line is complete', () => {
    const parser = createNdjsonParser<Row>()

    expect(parser.push('{"id":1}')).toEqual([])
    expect(parser.push('\n{"id":2}')).toEqual([{ id: 1 }])
    expect(parser.push('\n')).toEqual([{ id: 2 }])
  })

  it('reassembles a record split across chunks at any offset', () => {
    // Every split point of the same document, including the ones inside a key,
    // inside a number, and exactly on a newline.
    for (let size = 1; size <= DOCUMENT.length; size++) {
      expect(readInChunks<Row>(DOCUMENT, size)).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }])
    }
  })

  it('returns every record a single chunk completes', () => {
    const parser = createNdjsonParser<Row>()

    expect(parser.push(DOCUMENT)).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }])
  })

  it('parses a final record that arrived without a trailing newline', () => {
    const parser = createNdjsonParser<Row>()

    expect(parser.push('{"id":1}\n{"id":2}')).toEqual([{ id: 1 }])
    expect(parser.flush()).toEqual([{ id: 2 }])
  })

  it('flushes nothing for a document that ended on a line boundary', () => {
    const parser = createNdjsonParser<Row>()
    parser.push(DOCUMENT)

    expect(parser.flush()).toEqual([])
  })

  it('empties its buffer on flush, so a second call repeats nothing', () => {
    const parser = createNdjsonParser<Row>()
    parser.push('{"id":1}')

    expect(parser.flush()).toEqual([{ id: 1 }])
    expect(parser.flush()).toEqual([])
  })

  it('skips blank lines rather than parsing them', () => {
    const parser = createNdjsonParser<Row>()

    expect(parser.push('{"id":1}\n\n   \n{"id":2}\n')).toEqual([{ id: 1 }, { id: 2 }])
  })

  it('tolerates CRLF line endings', () => {
    const parser = createNdjsonParser<Row>()

    expect(parser.push('{"id":1}\r\n{"id":2}\r\n')).toEqual([{ id: 1 }, { id: 2 }])
  })

  it('throws on a malformed line instead of dropping it', () => {
    // Dropping it would turn a truncated stream into a response that is simply
    // missing records, with nothing anywhere saying so.
    const parser = createNdjsonParser<Row>()

    expect(() => parser.push('{"id":1\n')).toThrow(/Malformed NDJSON line/)
  })

  it('bounds the offending line in the error message', () => {
    // The line came off the network. Putting all of it in a thrown message
    // makes a bad record a megabyte in the browser console.
    const parser = createNdjsonParser<Row>()
    const error = captureThrow(() => parser.push(`{"id":"${'x'.repeat(5000)}\n`))

    expect(error.message).toMatch(/…$/)
    expect(error.message.length).toBeLessThan(200)
  })

  it('keeps the parse failure as the cause', () => {
    const parser = createNdjsonParser<Row>()
    const error = captureThrow(() => parser.push('nope\n'))

    expect(error.cause).toBeInstanceOf(SyntaxError)
  })
})

/** Returns what `fn` threw, and fails if it did not throw. */
function captureThrow(fn: () => unknown): Error {
  try {
    fn()
  } catch (error) {
    return error as Error
  }
  throw new Error('expected the call to throw')
}

describe('parseNdjson', () => {
  it('parses a complete document', () => {
    expect(parseNdjson<Row>(DOCUMENT)).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }])
  })

  it('parses a document with no trailing newline', () => {
    expect(parseNdjson<Row>('{"id":1}\n{"id":2}')).toEqual([{ id: 1 }, { id: 2 }])
  })

  it('parses an empty document as no records', () => {
    expect(parseNdjson<Row>('')).toEqual([])
  })
})
