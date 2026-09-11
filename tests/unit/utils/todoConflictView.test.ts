import { describe, expect, it } from 'vitest'

import { completedLabel, conflictRows, intentLabel } from '../../../utils/todoConflictView'

import type { TodoConflictState } from '~/composables/useTodoList'
import type { TodoItem } from '~/types/todos'

/**
 * What the conflict dialog shows, asserted where it is decidable.
 *
 * The unit suite runs in the `node` environment and Vitest here has no Vue SFC
 * compiler, so a `.vue` component cannot be mounted — which is why the part of
 * the dialog that can be *wrong* lives in a module instead of in the template. A
 * diff that misses a changed field invites the user to overwrite a change they
 * were never shown, and that is a property worth a test rather than a review.
 */

const MINE: TodoItem = {
  id: 'a',
  title: 'Alpha',
  completed: false,
  createdAt: '2026-01-01T09:00:00.000Z',
  version: 1,
}

function state(theirs: TodoItem | null, intent = { kind: 'toggle', completed: true } as const) {
  return { mine: { ...MINE, completed: true }, theirs, intent } satisfies TodoConflictState
}

describe('completedLabel', () => {
  it('reads as a status, not as a boolean', () => {
    expect(completedLabel(true)).toBe('Done')
    expect(completedLabel(false)).toBe('Not done')
  })
})

describe('intentLabel', () => {
  it('names the action the user took, not the mechanism that refused it', () => {
    expect(intentLabel({ kind: 'toggle', completed: true })).toBe('mark it done')
    expect(intentLabel({ kind: 'toggle', completed: false })).toBe('mark it not done')
    expect(intentLabel({ kind: 'remove' })).toBe('delete it')
  })
})

describe('conflictRows', () => {
  it('shows every field, including the ones both sides agree on', () => {
    // Dropping an agreeing row would leave the two columns with different
    // shapes, and a field missing from their column reads as a deletion.
    const rows = conflictRows(state({ ...MINE, completed: false, version: 2 }))

    expect(rows.map((row) => row.label)).toEqual(['Title', 'Status', 'Version'])
  })

  it('marks a field the other client changed', () => {
    const rows = conflictRows(state({ ...MINE, title: 'Alpha, renamed', version: 2 }))

    expect(rows[0]).toEqual({
      label: 'Title',
      mine: 'Alpha',
      theirs: 'Alpha, renamed',
      differs: true,
    })
  })

  it('does not mark a field the other client left alone', () => {
    const rows = conflictRows(state({ ...MINE, completed: false, version: 2 }))

    expect(rows[0]?.differs).toBe(false)
  })

  it('renders both statuses as the words the table shows', () => {
    const rows = conflictRows(state({ ...MINE, completed: false, version: 2 }))

    expect(rows[1]).toEqual({ label: 'Status', mine: 'Done', theirs: 'Not done', differs: true })
  })

  it('always marks the version row, which is what a conflict is', () => {
    const rows = conflictRows(state({ ...MINE, completed: true, version: 2 }))

    expect(rows[2]).toEqual({ label: 'Version', mine: '1', theirs: '2', differs: true })
  })

  it('has no rows when the other client deleted it', () => {
    // A table with one column is a worse way of saying "it is gone" than a
    // sentence is, and the dialog says it in one.
    expect(conflictRows(state(null))).toEqual([])
  })
})
