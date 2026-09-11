import type { TodoConflictState, TodoWriteIntent } from '../composables/useTodoList'

/**
 * What `TodoConflictDialog.vue` renders, worked out as plain functions.
 *
 * The dialog is a template over these. Pulling the comparison out of the SFC is
 * not tidiness: deciding which fields differ, and how each side reads, is the
 * part of a conflict UI that can be *wrong* — a diff that misses a changed field
 * invites the user to overwrite a change they were never shown — and it is
 * exactly the part that is awkward to assert on through rendered markup.
 */

/** One row of the side-by-side comparison. */
export interface ConflictFieldRow {
  /** The field's name, as the table's row header. */
  readonly label: string
  /** This client's value, rendered. */
  readonly mine: string
  /** The stored value, rendered. */
  readonly theirs: string
  /** Whether the two sides disagree. Drives the emphasis and the a11y note. */
  readonly differs: boolean
}

/** How a `completed` flag reads in the table. */
export function completedLabel(completed: boolean): string {
  return completed ? 'Done' : 'Not done'
}

/**
 * What this client was trying to do, in the user's words.
 *
 * Phrased to slot into "You tried to …", so the dialog's first sentence names
 * the action the user took rather than the mechanism that refused it. "Your
 * request failed the precondition" is accurate and tells them nothing.
 */
export function intentLabel(intent: TodoWriteIntent): string {
  if (intent.kind === 'remove') return 'delete it'
  return intent.completed ? 'mark it done' : 'mark it not done'
}

/**
 * The side-by-side rows for an open conflict.
 *
 * Empty when the other client deleted the todo: there is no second column to
 * compare against, and a table of one side is a worse way of saying "it is
 * gone" than a sentence is.
 *
 * A row is included even when both sides agree. Dropping it would leave the two
 * columns with different shapes, and a field missing from their column reads as
 * a deletion rather than as agreement.
 */
export function conflictRows(state: TodoConflictState): readonly ConflictFieldRow[] {
  const theirs = state.theirs
  if (theirs === null) return []

  return [
    {
      label: 'Title',
      mine: state.mine.title,
      theirs: theirs.title,
      differs: state.mine.title !== theirs.title,
    },
    {
      label: 'Status',
      mine: completedLabel(state.mine.completed),
      theirs: completedLabel(theirs.completed),
      differs: state.mine.completed !== theirs.completed,
    },
    {
      label: 'Version',
      mine: String(state.mine.version),
      theirs: String(theirs.version),
      // Always. A conflict is by definition a version disagreement, so a row
      // that computed this would be asserting something that cannot be false.
      differs: true,
    },
  ]
}
