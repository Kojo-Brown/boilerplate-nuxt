import { describe, it, expect } from 'vitest'

import {
  createValueComparator,
  defineColumn,
  findColumn,
  nextSortState,
  sortDirectionOf,
  sortRows,
} from '../../../utils/dataTable'

import type { ColumnDef } from '~/types/table'

/**
 * The table's model, tested without rendering anything.
 *
 * Every claim `components/DataTable.tsx` makes about ordering is decided here,
 * so these are the tests that would catch a table showing the right markup in
 * the wrong order — the failure a snapshot of the rendered HTML reports as
 * "something changed" and nothing more.
 */

interface Invoice {
  id: string
  client: string
  amount: number
  paid: boolean
  issued: Date
}

function invoice(overrides: Partial<Invoice> & { id: string }): Invoice {
  return {
    client: 'Acme',
    amount: 100,
    paid: false,
    issued: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  }
}

describe('createValueComparator', () => {
  const compare = createValueComparator()

  it('orders numbers numerically, not as text', () => {
    expect(compare(9, 10)).toBeLessThan(0)
    expect(compare(10, 9)).toBeGreaterThan(0)
    expect(compare(10, 10)).toBe(0)
  })

  it('orders numeric runs inside strings by value', () => {
    // The reason `numeric: true` is set: a plain code-unit comparison puts
    // 'item10' before 'item2', which is never what a table reader means.
    expect(compare('item2', 'item10')).toBeLessThan(0)
  })

  it('groups strings that differ only by case or accent', () => {
    expect(compare('acme', 'ACME')).toBe(0)
    expect(compare('resume', 'résumé')).toBe(0)
  })

  it('orders false before true', () => {
    expect(compare(false, true)).toBeLessThan(0)
    expect(compare(true, false)).toBeGreaterThan(0)
    expect(compare(true, true)).toBe(0)
  })

  it('orders dates by instant, not by their string form', () => {
    const earlier = new Date('2026-01-02T00:00:00.000Z')
    const later = new Date('2026-01-10T00:00:00.000Z')
    expect(compare(earlier, later)).toBeLessThan(0)
    expect(compare(later, earlier)).toBeGreaterThan(0)
  })

  it('orders bigints by value', () => {
    expect(compare(9n, 10n)).toBeLessThan(0)
  })

  it('puts null and undefined first, and treats them as equal to each other', () => {
    expect(compare(null, 0)).toBeLessThan(0)
    expect(compare(undefined, 'a')).toBeLessThan(0)
    expect(compare(5, null)).toBeGreaterThan(0)
    expect(compare(null, undefined)).toBe(0)
  })

  it('ties NaN with everything rather than scattering it', () => {
    // A comparator that returned a nonzero result for NaN would be
    // inconsistent — NaN < x and x < NaN are both false — and an inconsistent
    // comparator makes the whole sort undefined.
    expect(compare(Number.NaN, 1)).toBe(0)
    expect(compare(1, Number.NaN)).toBe(0)
  })

  it('falls back to comparing string forms for mixed types', () => {
    expect(compare(1, 'a')).toBeLessThan(0)
    expect(compare('a', 1)).toBeGreaterThan(0)
  })

  it('is a fresh comparator per call, sharing no state', () => {
    expect(createValueComparator()).not.toBe(createValueComparator())
  })
})

describe('defineColumn', () => {
  it('defaults to sortable, start-aligned, and String() text', () => {
    const column = defineColumn<Invoice, string>({
      id: 'client',
      header: 'Client',
      value: (row) => row.client,
    })

    expect(column.sortable).toBe(true)
    expect(column.align).toBe('start')
    expect(column.compare).toBeTypeOf('function')
    expect(column.text(invoice({ id: 'a', client: 'Acme' }))).toBe('Acme')
  })

  it('renders nothing for a nullish value rather than the word "null"', () => {
    const column = defineColumn<Invoice, string | null>({
      id: 'note',
      header: 'Note',
      value: () => null,
    })

    expect(column.text(invoice({ id: 'a' }))).toBe('')
  })

  it('formats dates as ISO-8601 by default, so the text does not follow the machine locale', () => {
    const column = defineColumn<Invoice, Date>({
      id: 'issued',
      header: 'Issued',
      value: (row) => row.issued,
    })

    expect(column.text(invoice({ id: 'a', issued: new Date('2026-03-04T05:06:07.000Z') }))).toBe(
      '2026-03-04T05:06:07.000Z',
    )
  })

  it('passes both the value and the whole row to a custom format', () => {
    const column = defineColumn<Invoice, number>({
      id: 'amount',
      header: 'Amount',
      value: (row) => row.amount,
      format: (amount, row) => `${amount} (${row.client})`,
    })

    expect(column.text(invoice({ id: 'a', amount: 42, client: 'Globex' }))).toBe('42 (Globex)')
  })

  it('has no comparator at all when the column is not sortable', () => {
    // Not a comparator that returns 0: the table asks whether an order exists,
    // and "every row ties" is a different answer from "there is no order".
    const column = defineColumn<Invoice, string>({
      id: 'actions',
      header: '',
      value: () => '',
      sortable: false,
    })

    expect(column.compare).toBeUndefined()
  })

  it('compares rows through the value extractor, using a custom compare', () => {
    const priority = ['low', 'high'] as const
    const column = defineColumn<{ level: 'low' | 'high' }, 'low' | 'high'>({
      id: 'level',
      header: 'Level',
      value: (row) => row.level,
      compare: (a, b) => priority.indexOf(a) - priority.indexOf(b),
    })

    expect(column.compare?.({ level: 'low' }, { level: 'high' })).toBeLessThan(0)
  })
})

describe('findColumn', () => {
  const columns: readonly ColumnDef<Invoice>[] = [
    defineColumn<Invoice, string>({ id: 'client', header: 'Client', value: (row) => row.client }),
  ]

  it('finds a column by id', () => {
    expect(findColumn(columns, 'client')?.header).toBe('Client')
  })

  it('returns undefined for an id no column has', () => {
    expect(findColumn(columns, 'nope')).toBeUndefined()
  })
})

describe('sortDirectionOf', () => {
  it('reports a direction only for the column that is actually sorted', () => {
    const sort = { columnId: 'amount', direction: 'descending' } as const

    expect(sortDirectionOf(sort, 'amount')).toBe('descending')
    expect(sortDirectionOf(sort, 'client')).toBeNull()
    expect(sortDirectionOf(null, 'amount')).toBeNull()
  })
})

describe('nextSortState', () => {
  it('cycles one column through ascending, descending, unsorted', () => {
    const first = nextSortState(null, 'amount')
    expect(first).toEqual({ columnId: 'amount', direction: 'ascending' })

    const second = nextSortState(first, 'amount')
    expect(second).toEqual({ columnId: 'amount', direction: 'descending' })

    // The third click has to be reachable: the unsorted order usually means
    // something on its own, and a two-state toggle makes it unrecoverable.
    expect(nextSortState(second, 'amount')).toBeNull()
  })

  it('starts a different column at ascending rather than inheriting the direction', () => {
    const descending = { columnId: 'amount', direction: 'descending' } as const

    expect(nextSortState(descending, 'client')).toEqual({
      columnId: 'client',
      direction: 'ascending',
    })
  })
})

describe('sortRows', () => {
  const client = defineColumn<Invoice, string>({
    id: 'client',
    header: 'Client',
    value: (row) => row.client,
  })
  const amount = defineColumn<Invoice, number>({
    id: 'amount',
    header: 'Amount',
    value: (row) => row.amount,
  })
  const actions = defineColumn<Invoice, string>({
    id: 'actions',
    header: '',
    value: () => '',
    sortable: false,
  })
  const columns: readonly ColumnDef<Invoice>[] = [client, amount, actions]

  const rows: readonly Invoice[] = [
    invoice({ id: 'a', client: 'Initech', amount: 300 }),
    invoice({ id: 'b', client: 'Acme', amount: 100 }),
    invoice({ id: 'c', client: 'Globex', amount: 100 }),
  ]

  const ids = (result: readonly Invoice[]): string[] => result.map((row) => row.id)

  it('hands back the very same array when there is nothing to do', () => {
    // Referential equality, not just equal contents: an unsorted table should
    // not hand its consumer a new array on every render.
    expect(sortRows(rows, columns, null)).toBe(rows)
    expect(sortRows(rows, columns, { columnId: 'missing', direction: 'ascending' })).toBe(rows)
    expect(sortRows(rows, columns, { columnId: 'actions', direction: 'ascending' })).toBe(rows)
  })

  it('sorts ascending and descending by the named column', () => {
    expect(ids(sortRows(rows, columns, { columnId: 'client', direction: 'ascending' }))).toEqual([
      'b',
      'c',
      'a',
    ])
    expect(ids(sortRows(rows, columns, { columnId: 'client', direction: 'descending' }))).toEqual([
      'a',
      'c',
      'b',
    ])
  })

  it('keeps tied rows in input order in both directions', () => {
    // 'b' and 'c' both cost 100. Negating the comparator would also negate the
    // tiebreak and quietly swap them when the direction flips.
    expect(ids(sortRows(rows, columns, { columnId: 'amount', direction: 'ascending' }))).toEqual([
      'b',
      'c',
      'a',
    ])
    expect(ids(sortRows(rows, columns, { columnId: 'amount', direction: 'descending' }))).toEqual([
      'a',
      'b',
      'c',
    ])
  })

  it('returns the original arrangement after a full ascending → descending → ascending cycle', () => {
    const ascending = sortRows(rows, columns, { columnId: 'amount', direction: 'ascending' })
    const descending = sortRows(rows, columns, { columnId: 'amount', direction: 'descending' })
    const again = sortRows(rows, columns, { columnId: 'amount', direction: 'ascending' })

    expect(ids(again)).toEqual(ids(ascending))
    expect(ids(again)).not.toEqual(ids(descending))
  })

  it('never mutates the array it was given', () => {
    const input = [...rows]
    sortRows(input, columns, { columnId: 'client', direction: 'descending' })

    expect(ids(input)).toEqual(['a', 'b', 'c'])
  })
})
