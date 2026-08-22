import type { ColumnDef, ColumnSpec, SortDirection, SortState } from '~/types/table'

/**
 * The table's model, with no Vue in it.
 *
 * Everything a data table does that can be wrong — which column is sorted, in
 * which direction, in what order the rows come out, what a cell says — is
 * decided here, by functions that take values and return values. The component
 * in `components/DataTable.tsx` turns the result into elements and does nothing
 * else, which is why its tests can be about markup and these can be about
 * ordering.
 */

/**
 * Builds a comparator for values of unknown type, ascending.
 *
 * A factory rather than a shared constant because it owns an `Intl.Collator`:
 * constructing one costs enough to be worth reusing across a sort, and holding
 * it at module scope would put a shared object in the graph of every module
 * that imports this one — the thing `composable-design/no-module-state` exists
 * to prevent. One per sort is the right lifetime.
 *
 * The order between types is fixed rather than clever: nullish first, then
 * booleans, numbers, dates and strings compared within their own kind. Mixed
 * types fall back to comparing their string forms, which is arbitrary but
 * total — a comparator that returned an inconsistent order for mixed data would
 * make the sort itself undefined behaviour.
 *
 * `NaN` compares equal to everything, so a column of numbers with holes in it
 * keeps the holes where they were rather than scattering them.
 */
export function createValueComparator(): (a: unknown, b: unknown) => number {
  // `numeric: true` so 'item2' sorts before 'item10'; `sensitivity: 'base'` so
  // case and accents do not split what a reader sees as one group. The locale
  // is pinned to 'en' on purpose: the sort order of a table must not change
  // with the machine's locale, or a test that passes locally fails in CI.
  const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' })

  return function compare(a: unknown, b: unknown): number {
    const aMissing = a === null || a === undefined
    const bMissing = b === null || b === undefined
    if (aMissing || bMissing) return aMissing === bMissing ? 0 : aMissing ? -1 : 1

    if (typeof a === 'boolean' && typeof b === 'boolean') {
      return a === b ? 0 : a ? 1 : -1
    }
    if (typeof a === 'number' && typeof b === 'number') {
      return a < b ? -1 : a > b ? 1 : 0
    }
    if (typeof a === 'bigint' && typeof b === 'bigint') {
      return a < b ? -1 : a > b ? 1 : 0
    }
    if (a instanceof Date && b instanceof Date) {
      const left = a.getTime()
      const right = b.getTime()
      return left < right ? -1 : left > right ? 1 : 0
    }
    if (typeof a === 'string' && typeof b === 'string') {
      return collator.compare(a, b)
    }
    return collator.compare(String(a), String(b))
  }
}

/** Null-safe default cell text: nothing renders as empty, dates as ISO-8601. */
function defaultFormat(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (value instanceof Date) return value.toISOString()
  return String(value)
}

/**
 * Builds a {@link ColumnDef} from a spec, checking `value`, `format` and
 * `compare` against each other and then closing over the value type.
 *
 * This function is the only place the three meet while `Value` is still
 * visible. After it returns, the column is just `(row) => string` and
 * `(a, b) => number`, so an array of columns over the same `Row` is
 * homogeneous no matter how different the cell values are.
 */
export function defineColumn<Row, Value>(spec: ColumnSpec<Row, Value>): ColumnDef<Row> {
  const sortable = spec.sortable ?? true
  const format = spec.format ?? ((value: Value): string => defaultFormat(value))
  const compareValues = spec.compare ?? createValueComparator()

  return {
    id: spec.id,
    header: spec.header,
    align: spec.align ?? 'start',
    sortable,
    text: (row) => format(spec.value(row), row),
    // Undefined rather than a comparator that always returns 0: the table asks
    // whether an order exists, and "yes, but every row ties" is a different
    // answer from "no".
    compare: sortable ? (a, b) => compareValues(spec.value(a), spec.value(b)) : undefined,
  }
}

/** The column with this id, or `undefined`. */
export function findColumn<Row>(
  columns: readonly ColumnDef<Row>[],
  columnId: string,
): ColumnDef<Row> | undefined {
  return columns.find((column) => column.id === columnId)
}

/**
 * The direction this column is sorted in, or `null` if the table is unsorted or
 * sorted by a different column.
 */
export function sortDirectionOf(sort: SortState | null, columnId: string): SortDirection | null {
  return sort !== null && sort.columnId === columnId ? sort.direction : null
}

/**
 * The next sort state after activating `columnId`.
 *
 * Three states, not two: ascending → descending → unsorted. The third click
 * getting the original order back matters because the unsorted order is
 * usually meaningful on its own — insertion order, or whatever the server
 * ranked by — and a two-state toggle makes it unreachable without a reload.
 *
 * Activating a different column always starts at ascending rather than
 * inheriting the previous column's direction, so the same click on the same
 * header always produces the same result.
 */
export function nextSortState(current: SortState | null, columnId: string): SortState | null {
  if (current === null || current.columnId !== columnId) {
    return { columnId, direction: 'ascending' }
  }
  return current.direction === 'ascending' ? { columnId, direction: 'descending' } : null
}

/**
 * Rows in the order the table should display them.
 *
 * Returns the input array itself — not a copy — whenever there is nothing to
 * do: no sort, an unknown column, or a column with no order. The caller gets
 * referential equality for the common case, and never gets its own array
 * mutated for the other one.
 *
 * The sort is stable regardless of the engine. `Array.prototype.sort` has been
 * required to be stable since ES2019, but stability here has to survive the
 * *direction* flip too: negating the comparator would also negate the tiebreak
 * and silently reverse equal rows. Comparing the original index separately,
 * after the direction is applied, keeps ties in input order in both
 * directions — so toggling ascending → descending → ascending returns the
 * exact arrangement it started from.
 */
export function sortRows<Row>(
  rows: readonly Row[],
  columns: readonly ColumnDef<Row>[],
  sort: SortState | null,
): readonly Row[] {
  if (sort === null) return rows

  const column = findColumn(columns, sort.columnId)
  const compare = column?.compare
  if (compare === undefined) return rows

  const direction = sort.direction === 'ascending' ? 1 : -1

  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => {
      const result = compare(a.row, b.row)
      return result !== 0 ? result * direction : a.index - b.index
    })
    .map((entry) => entry.row)
}
