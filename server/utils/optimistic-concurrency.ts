/**
 * Optimistic concurrency: the `If-Match` / `ETag` half of it.
 *
 * This module is the rules — parsing a precondition, formatting an entity tag,
 * deciding what a mismatch means — with no Nitro import anywhere in it, so it is
 * unit-testable as plain functions. `server/utils/todo-store.ts` holds the
 * statement that enforces the decision in SQL, and the route files translate the
 * outcome into a status code. Same split as `idempotency.ts` /
 * `idempotent-route.ts`.
 *
 * ## The shape of the mechanism
 *
 * A row carries a `version` counter. A reader is told which version it read
 * (`ETag: "4"`); a writer says which version it believed it was changing
 * (`If-Match: "4"`); the write is `… WHERE id = $1 AND version = 4`, and it sets
 * `version = 5` in the same statement. Two writers that both read 4 therefore
 * cannot both succeed — the second matches no row, and the row it wanted is
 * already at 5.
 *
 * The check has to be part of the writing statement. A handler that reads the
 * row, compares versions in TypeScript, and then updates has simply moved the
 * race: the comparison and the write are two statements, and a competing
 * transaction fits between them. Nothing in this file can prevent that mistake,
 * which is why {@link todoUpdateStatement} exists rather than a
 * `assertVersion(expected, actual)` helper that would look just as correct.
 *
 * ## Why this is not pessimistic locking
 *
 * `SELECT … FOR UPDATE` would also make the two writes safe, by making the
 * second wait. That is the right tool when conflicts are common and the holder
 * releases quickly. It is the wrong tool across a *think time* — the minutes
 * between a user opening a form and submitting it — because the lock would be
 * held by a database transaction spanning two HTTP requests, and the user who
 * wandered off to lunch would block the rest of the team. Optimistic control
 * pays nothing in the common case and makes the rare case the client's problem
 * to resolve, which is why every collaborative editor works this way.
 */

/** The request header a client sends its expected version in. */
export const IF_MATCH_HEADER = 'if-match'

/** The response header every todo representation carries its version in. */
export const ETAG_HEADER = 'etag'

/**
 * Formats a row version as a strong entity tag: version 4 → `"4"`.
 *
 * Strong, not weak (`W/"4"`), and that is a claim worth being sure about: a
 * strong tag asserts the bytes are identical, and two responses for the same
 * `version` of a todo *are* byte-identical, because every column a response
 * exposes changes only through an update that bumps the version. A weak tag
 * would be the honest choice for a representation that also varies by, say, the
 * caller's locale — and would then be unusable in `If-Match`, which RFC 9110
 * §13.1.1 defines as a strong comparison.
 *
 * The quotes are part of the value, not decoration: an unquoted `4` is not a
 * valid entity tag and clients are entitled to reject it.
 */
export function versionETag(version: number): string {
  return `"${version}"`
}

/** What an `If-Match` header turned out to be asking for. */
export type Precondition =
  /** No header. The caller did not state an expectation. */
  | { readonly kind: 'absent' }
  /** `If-Match: *` — "whatever version it is, as long as it exists". */
  | { readonly kind: 'any' }
  /** One or more entity tags, parsed to the versions they name. */
  | { readonly kind: 'versions'; readonly versions: readonly number[] }
  /** Syntactically present and unusable. Never treated as `absent`. */
  | { readonly kind: 'malformed'; readonly reason: string }

/**
 * One entity tag: optionally weak, then a quoted string. Anchored, so a tag
 * with trailing junk is malformed rather than silently truncated to its prefix.
 */
const ETAG_PATTERN = /^(W\/)?"([^"]*)"$/

/** A version is a non-negative integer with no sign, padding, or exponent. */
const VERSION_PATTERN = /^(0|[1-9][0-9]*)$/

/**
 * Parses `If-Match` into the versions it names.
 *
 * A list is accepted (`"3", "4"`) because RFC 9110 defines one, and it has a
 * real use: a client that retried a write and does not know whether the first
 * attempt landed can accept either the version it read or the one its own write
 * would have produced. A single tag is the normal case.
 *
 * Two things are deliberately *not* tolerated. A weak tag (`W/"4"`) is rejected
 * rather than compared leniently, because `If-Match` is a strong comparison by
 * definition and quietly accepting one would mean the header no longer says what
 * the specification says it says. A tag whose body is not an integer is rejected
 * rather than dropped from the list, because a client that sends
 * `If-Match: "v4"` has a bug that a 400 will surface in minutes and a silently
 * ignored precondition will not surface until two writes collide in production.
 */
export function parseIfMatch(header: string | undefined): Precondition {
  if (header === undefined) return { kind: 'absent' }

  const trimmed = header.trim()
  if (trimmed.length === 0) {
    return { kind: 'malformed', reason: 'the header is empty' }
  }
  if (trimmed === '*') return { kind: 'any' }

  const versions: number[] = []

  for (const candidate of trimmed.split(',')) {
    const tag = candidate.trim()
    if (tag.length === 0) {
      return { kind: 'malformed', reason: `"${trimmed}" has an empty entity tag in its list` }
    }

    const match = ETAG_PATTERN.exec(tag)
    if (match === null) {
      return {
        kind: 'malformed',
        reason: `${tag} is not a quoted entity tag — expected something like "4"`,
      }
    }
    if (match[1] !== undefined) {
      return {
        kind: 'malformed',
        reason: `${tag} is a weak entity tag, and If-Match is a strong comparison`,
      }
    }

    const body = match[2] ?? ''
    if (!VERSION_PATTERN.test(body)) {
      return {
        kind: 'malformed',
        reason: `${tag} does not name a version — the tag body must be a whole number`,
      }
    }

    versions.push(Number(body))
  }

  return { kind: 'versions', versions }
}

/** What a route should do about the precondition it was given. */
export type PreconditionDecision =
  /**
   * Proceed. `expected` is the version to guard the write with, or `null` for
   * `If-Match: *`, which asks only that the row exist.
   */
  | { readonly kind: 'proceed'; readonly expected: number | null }
  /** 428: the route requires a precondition and none was sent. */
  | { readonly kind: 'required' }
  /** 400: a precondition was sent and could not be understood. */
  | { readonly kind: 'malformed'; readonly reason: string }

/** Options for {@link decidePrecondition}. */
export interface PreconditionOptions {
  /**
   * Whether a missing `If-Match` is an error.
   *
   * `true` for the mutating todo routes. A write with no precondition is a
   * last-write-wins write, and a route that accepts both silently gives every
   * client the choice of opting out of the guarantee the column exists to
   * provide — including by forgetting. 428 Precondition Required (RFC 6585 §3)
   * is the status invented for exactly this, and unlike a 400 it tells the
   * client the request is fine and merely unconditional.
   */
  readonly required: boolean
}

/** Turns a raw header into the decision a route acts on. */
export function decidePrecondition(
  header: string | undefined,
  options: PreconditionOptions,
): PreconditionDecision {
  const precondition = parseIfMatch(header)

  switch (precondition.kind) {
    case 'absent':
      return options.required ? { kind: 'required' } : { kind: 'proceed', expected: null }
    case 'malformed':
      return { kind: 'malformed', reason: precondition.reason }
    case 'any':
      return { kind: 'proceed', expected: null }
    case 'versions':
      // The list is an "any of these" match, and the statement guards on one
      // number. Taking the highest is the only choice that cannot lose a write:
      // it is the newest version the client claims to be current with, so a
      // guard on it fails whenever the row has moved past everything the client
      // knows about. Guarding on the lowest would let a client that sent
      // `"3", "4"` overwrite version 4 while believing it held 3.
      return { kind: 'proceed', expected: Math.max(...precondition.versions) }
  }
}

/**
 * Why a version-guarded write matched no row.
 *
 * The two cases are not interchangeable and the client does different things
 * with them: `stale` means somebody else edited the row and there is a current
 * version to merge against; `missing` means somebody else deleted it and there
 * is nothing to merge with at all.
 */
export type WriteMiss =
  { readonly kind: 'stale'; readonly actual: number } | { readonly kind: 'missing' }

/** The body a 412 carries, so the client can render the conflict. */
export interface ConflictBody<T> {
  /**
   * The row as it is now, or `null` when it has been deleted.
   *
   * Sent with the error on purpose. The alternative — a bare 412 and a client
   * that re-fetches — costs a round trip at the exact moment the client is
   * already behind, and opens a second race: the re-fetch can land after *another*
   * edit, so the conflict UI would show a third version that neither writer
   * ever saw.
   */
  readonly current: T | null
  /** The version the client said it held. */
  readonly expected: number | null
  /** The version the row is actually at, or `null` when it is gone. */
  readonly actual: number | null
}

/** Builds the 412 body from the miss and the row the route re-read. */
export function conflictBody<T>(
  miss: WriteMiss,
  current: T | null,
  expected: number | null,
): ConflictBody<T> {
  return {
    current: miss.kind === 'missing' ? null : current,
    expected,
    actual: miss.kind === 'missing' ? null : miss.actual,
  }
}

/** The human-readable half of a 412, which ends up in the client's error. */
export function conflictMessage(miss: WriteMiss, expected: number | null): string {
  if (miss.kind === 'missing') {
    return 'This todo no longer exists — it was deleted while you were editing it.'
  }
  return (
    `This todo has changed since you loaded it: you have version ${expected ?? '?'}, ` +
    `it is now at version ${miss.actual}.`
  )
}
