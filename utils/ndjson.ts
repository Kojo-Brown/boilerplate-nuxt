/**
 * Reading NDJSON off a stream, one arbitrary chunk at a time.
 *
 * A `ReadableStream` hands out whatever bytes have arrived, and the network has
 * no opinion about where a line ends. So a reader gets chunks like these, and
 * has to produce three records from them:
 *
 * ```text
 * chunk 1: {"type":"item","index":0,"data":{"id":1}}\n{"type":"item","in
 * chunk 2: dex":1,"data":{"id":2}}\n{"type":"end","count":2,
 * chunk 3: "elapsedMs":42}\n
 * ```
 *
 * `JSON.parse(chunk)` fails on all three. Splitting each chunk on `\n` and
 * parsing the pieces fails on the second half of record 2. What works is one
 * buffer that persists across chunks and only ever parses a line it has seen the
 * end of, which is what {@link createNdjsonParser} is.
 *
 * Two things it deliberately does not do:
 *
 *  - **Decode bytes.** A chunk boundary can also fall inside a multi-byte UTF-8
 *    character, and the fix for that is a `TextDecoder` with `{ stream: true }`,
 *    which holds the incomplete sequence for the next call. The parser takes
 *    strings so that decoding stays where it can be done correctly, once, at the
 *    edge — see `composables/useNdjsonStream.ts`.
 *  - **Skip a line it cannot parse.** A malformed line is a truncated stream or
 *    a protocol mismatch, and a parser that drops it turns either into a
 *    response that is quietly missing records.
 */

/** Incremental NDJSON reader. Not reusable across streams — make one per read. */
export interface NdjsonParser<T> {
  /**
   * Adds a chunk and returns every record it completed. A chunk that finishes
   * no line returns nothing and is kept for the next call.
   */
  push(chunk: string): T[]
  /**
   * Parses whatever is left once the stream has ended, for a final record that
   * arrived without its trailing newline. Returns nothing for a stream that
   * ended on a line boundary, which is the normal case.
   */
  flush(): T[]
}

/**
 * Parses one line, with the offending text in the error.
 *
 * The message carries a bounded slice of the line rather than the whole thing:
 * this runs in the browser on a response the server chose, and an unbounded one
 * turns a bad record into a megabyte in the console.
 */
function parseLine<T>(line: string): T {
  try {
    return JSON.parse(line) as T
  } catch (cause) {
    const preview = line.length > 120 ? `${line.slice(0, 120)}…` : line
    throw new Error(`Malformed NDJSON line: ${preview}`, { cause })
  }
}

/**
 * A line is complete when a `\n` has been seen. `\r\n` is the same line with one
 * more character on it — servers behind a proxy that rewrites line endings are
 * rare, but the alternative is `JSON.parse` failing on an invisible character.
 */
function stripLineEnding(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line
}

/** True for a line with nothing on it. NDJSON allows blank lines between records. */
function isBlank(line: string): boolean {
  return line.trim() === ''
}

export function createNdjsonParser<T>(): NdjsonParser<T> {
  let buffer = ''

  return {
    push(chunk: string): T[] {
      buffer += chunk

      const lines = buffer.split('\n')
      // `split` always returns one more element than there are separators, and
      // that last element is the text after the final `\n` — the incomplete
      // line. For a chunk ending exactly on a newline it is the empty string,
      // which is the same thing said about zero characters.
      buffer = lines.pop() ?? ''

      return lines
        .map(stripLineEnding)
        .filter(hasContent)
        .map(parseLine<T>)
    },

    flush(): T[] {
      const remainder = stripLineEnding(buffer)
      buffer = ''
      return isBlank(remainder) ? [] : [parseLine<T>(remainder)]
    },
  }
}

function hasContent(line: string): boolean {
  return !isBlank(line)
}

/**
 * Parses a complete NDJSON document. The non-streaming case — a test fixture, a
 * file, a response small enough to have been read whole.
 */
export function parseNdjson<T>(text: string): T[] {
  const parser = createNdjsonParser<T>()
  return [...parser.push(text), ...parser.flush()]
}
