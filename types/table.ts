/**
 * The contracts a data table renders against.
 *
 * The shape of these types is the whole reason `DataTable` is a render function
 * rather than a template. A template describes one fixed arrangement of
 * elements; this describes a *list* of columns, decided at runtime, each of
 * which may be rendered by the column itself, by a slot the parent passed down,
 * or by a fallback — and the slot's name is derived from the column's id. All
 * three of those are one line in a render function and a fight in a template.
 *
 * Nothing here imports from Vue except `VNode`, so the model can be built and
 * asserted on without rendering anything.
 */

import type { VNode } from 'vue'

/** Which edge a column's content sits against. `end` is for numeric columns. */
export type ColumnAlign = 'start' | 'end'

/**
 * A sort direction, spelled the way `aria-sort` spells it.
 *
 * `'asc' | 'desc'` would read better in application code and then have to be
 * mapped at every point it reaches the DOM. These values go straight into the
 * `aria-sort` attribute, so the header cell cannot drift out of agreement with
 * the order the rows are actually in.
 */
export type SortDirection = 'ascending' | 'descending'

/**
 * Which column the table is sorted by, and how.
 *
 * `null` — rather than a third `'none'` direction — is the unsorted state, so
 * "sorted by nothing" cannot also carry a stale column id.
 */
export interface SortState {
  readonly columnId: string
  readonly direction: SortDirection
}

/**
 * A column as the table consumes it: its identity, how to turn a row into text,
 * and how to order two rows by it.
 *
 * The row type survives but the *cell value* type does not — `text` and
 * `compare` both close over it. That erasure is deliberate. A column list is
 * heterogeneous by nature (a string column beside a number column beside a
 * date), so a `ColumnDef<Row, Value>` could never be put in one array without
 * widening `Value` to `unknown` and casting it back at every use.
 * {@link ColumnSpec} is where the value type is still visible, and
 * `defineColumn` is the boundary that checks the two functions against each
 * other and then closes over it.
 */
export interface ColumnDef<Row> {
  /** Stable identity. Also the suffix of this column's slot names. */
  readonly id: string
  /** Default header text, used when no `header:<id>` slot is supplied. */
  readonly header: string
  readonly align: ColumnAlign
  /** Whether the header offers a sort control. False when there is no order. */
  readonly sortable: boolean
  /** The cell's text, used when no `cell:<id>` slot is supplied. */
  readonly text: (row: Row) => string
  /**
   * Orders two rows by this column, ascending. `undefined` exactly when
   * {@link sortable} is false, so a caller cannot ask for an order that does
   * not exist.
   */
  readonly compare: ((a: Row, b: Row) => number) | undefined
}

/**
 * A column as it is written, before `defineColumn` erases `Value`.
 *
 * `value` is extracted once and handed to both `format` and `compare`, so a
 * column cannot sort by one thing and display another by accident.
 */
export interface ColumnSpec<Row, Value> {
  /** Stable identity. Also the suffix of this column's slot names. */
  id: string
  /** Default header text. */
  header: string
  /** Pulls this column's value out of a row. */
  value: (row: Row) => Value
  /**
   * Turns the value into cell text. Defaults to a null-safe `String()`; supply
   * one for anything whose display form is a decision — money, dates, units.
   */
  format?: (value: Value, row: Row) => string
  /**
   * Orders two values, ascending. Defaults to a comparator that handles
   * numbers, booleans, dates, and strings; supply one for a domain order such
   * as `low | medium | high`.
   */
  compare?: (a: Value, b: Value) => number
  /** Defaults to `true`. Set false for a column with no meaningful order. */
  sortable?: boolean
  /** Defaults to `'start'`. */
  align?: ColumnAlign
}

/** What a `cell:<id>` slot receives. */
export interface CellScope<Row> {
  readonly row: Row
  /** Index into the rows *as displayed*, so it follows the current sort. */
  readonly rowIndex: number
  readonly column: ColumnDef<Row>
  /**
   * What the column would have rendered on its own. Passed so a slot can
   * decorate the default text — wrap it in a badge, add an icon — without
   * restating the column's own formatting.
   */
  readonly text: string
}

/** What a `header:<id>` slot receives. */
export interface HeaderScope<Row> {
  readonly column: ColumnDef<Row>
  /** This column's direction, or `null` when the table is sorted by another. */
  readonly sorted: SortDirection | null
  /**
   * Advances this column's sort: unsorted → ascending → descending → unsorted.
   * A custom header still drives the same state machine as the default one.
   */
  readonly toggle: () => void
}

/** What a `footer` slot receives: the rows as displayed, and the columns. */
export interface FooterScope<Row> {
  readonly rows: readonly Row[]
  readonly columns: readonly ColumnDef<Row>[]
}

/**
 * Every slot `DataTable` renders.
 *
 * The two pattern index signatures are what a template cannot declare: the set
 * of valid slot names is not fixed, it is one `header:` and one `cell:` per
 * column in whatever column list the caller passed. TypeScript checks the
 * *shape* of the name, so `#cell:amount` gets a `CellScope` and a typo like
 * `#cel:amount` is not a slot this table has — it is simply never called, the
 * same failure a template would give, but the scope type is still right for
 * every name that does match.
 */
export interface DataTableSlots<Row> {
  /** Replaces the `caption` prop with arbitrary content. */
  caption?: () => VNode[]
  /** Rendered in place of the rows when there are none. */
  empty?: () => VNode[]
  /** Rendered in a `<tfoot>`. Omitted entirely when the slot is absent. */
  footer?: (scope: FooterScope<Row>) => VNode[]
  /** `header:<column id>` — replaces one column's header cell content. */
  [header: `header:${string}`]: ((scope: HeaderScope<Row>) => VNode[]) | undefined
  /** `cell:<column id>` — replaces one column's body cell content. */
  [cell: `cell:${string}`]: ((scope: CellScope<Row>) => VNode[]) | undefined
}
