import type { SetupContext, SlotsType, VNode } from 'vue'

import { nextSortState, sortDirectionOf, sortRows } from '../utils/dataTable'

import type { CellScope, ColumnDef, DataTableSlots, HeaderScope, SortState } from '~/types/table'

/**
 * A table whose columns are data, written as a render function.
 *
 * ## Why this one is not a template
 *
 * A template is a good description of a fixed tree. Everything this component
 * does is the other thing:
 *
 * - The columns are a runtime array, so every `<th>` and every `<td>` is
 *   produced by mapping over it. A template can `v-for` that, but each cell
 *   then needs its content chosen from three sources.
 * - The slot names are *derived*: `cell:${column.id}`. A template reaches
 *   dynamic slot names only through `<template v-slot:[expr]>`, and the
 *   argument of a dynamic directive cannot be type-checked at all.
 * - The choice per cell is "the parent's slot for this column, else the
 *   column's own text" — a `??` in a render function, a `<slot>` fallback plus
 *   a `v-if` in a template, repeated for headers, cells, caption and footer.
 *
 * The result is that the interesting logic reads as ordinary TypeScript with
 * ordinary types, and JSX carries only the shape of the markup.
 *
 * ## Sorting is controlled
 *
 * The table holds no state. It renders the `sort` prop and emits
 * `update:sort` — so `v-model:sort` works, and so a page can put the sort in
 * the URL, share it between two tables, or restore it from a store without the
 * component growing an option for each case. {@link sortRows} decides the
 * order; this file only decides what the order looks like.
 */

/** The props `DataTable` renders from. */
export interface DataTableProps<Row> {
  /** Rows in their natural order. Sorting is applied here, not by the caller. */
  rows: readonly Row[]
  /** The columns to render, in display order. Built with `defineColumn`. */
  columns: readonly ColumnDef<Row>[]
  /**
   * A stable identity per row, for the `key` on each `<tr>`. Required rather
   * than defaulted to the index, because an index key is exactly wrong for a
   * table that reorders itself: Vue would patch every row on every sort.
   */
  rowKey: (row: Row) => string | number
  /** The current sort, or `null`. Pair with `onUpdate:sort` (or `v-model`). */
  sort?: SortState | null
  /** Caption text. The `caption` slot overrides it. */
  caption?: string
  /** Shown when `rows` is empty. The `empty` slot overrides it. */
  emptyText?: string
}

/** `update:sort` carries the whole next state, including `null` for unsorted. */
export type DataTableEmits = {
  'update:sort': (sort: SortState | null) => void
}

/**
 * What Vue hands a functional component as its second argument: the setup
 * context minus `expose`, which only a stateful component has.
 */
type DataTableContext<Row> = Omit<
  SetupContext<DataTableEmits, SlotsType<DataTableSlots<Row>>>,
  'expose'
>

/** Tailwind's `text-start` / `text-end`, chosen by the column's alignment. */
function alignClass<Row>(column: ColumnDef<Row>): string {
  return column.align === 'end' ? 'text-end' : 'text-start'
}

/**
 * One `<th>`.
 *
 * `aria-sort` is set only on sortable columns, and to `'none'` rather than
 * omitted while they are unsorted — that is the difference between "this column
 * can be sorted and currently is not" and "this column has no order", which is
 * the whole information a screen reader needs to describe the control.
 */
function renderHeaderCell<Row>(
  column: ColumnDef<Row>,
  sort: SortState | null,
  slots: DataTableContext<Row>['slots'],
  emit: DataTableContext<Row>['emit'],
): VNode {
  const sorted = sortDirectionOf(sort, column.id)
  const toggle = (): void => {
    emit('update:sort', nextSortState(sort, column.id))
  }

  const slot = slots[`header:${column.id}`]
  const scope: HeaderScope<Row> = { column, sorted, toggle }

  return (
    <th
      scope="col"
      aria-sort={column.sortable ? (sorted ?? 'none') : undefined}
      class={[
        'border-b border-[var(--color-border)] px-3 py-2 text-xs font-semibold tracking-wide text-[var(--color-muted-foreground)] uppercase',
        alignClass(column),
      ]}
    >
      {slot
        ? slot(scope)
        : column.sortable
          ? renderSortButton(column, sorted, toggle)
          : column.header}
    </th>
  )
}

/**
 * The default sortable header: a real `<button>`, so the control is reachable
 * by keyboard and announced as a control. The arrow is decorative — `aria-sort`
 * on the cell already carries the state — so it is hidden from the accessibility
 * tree rather than read out as a character name.
 */
function renderSortButton<Row>(
  column: ColumnDef<Row>,
  sorted: 'ascending' | 'descending' | null,
  toggle: () => void,
): VNode {
  const indicator = sorted === 'ascending' ? '↑' : sorted === 'descending' ? '↓' : '↕'

  return (
    <button
      type="button"
      class="inline-flex items-center gap-1 rounded text-inherit uppercase hover:text-[var(--color-foreground)] focus-visible:ring-2 focus-visible:ring-[var(--color-primary)] focus-visible:outline-none"
      onClick={toggle}
    >
      {column.header}
      <span aria-hidden="true" class={sorted === null ? 'opacity-40' : ''}>
        {indicator}
      </span>
    </button>
  )
}

/** One `<td>`: the parent's `cell:<id>` slot if it supplied one, else the column's text. */
function renderBodyCell<Row>(
  column: ColumnDef<Row>,
  row: Row,
  rowIndex: number,
  slots: DataTableContext<Row>['slots'],
): VNode {
  const text = column.text(row)
  const slot = slots[`cell:${column.id}`]
  const scope: CellScope<Row> = { row, rowIndex, column, text }

  return (
    <td
      class={['px-3 py-2 text-sm text-[var(--color-foreground)] tabular-nums', alignClass(column)]}
    >
      {slot ? slot(scope) : text}
    </td>
  )
}

export function DataTable<Row>(
  props: DataTableProps<Row>,
  { slots, emit }: DataTableContext<Row>,
): VNode {
  const sort = props.sort ?? null
  const columns = props.columns
  const rows = sortRows(props.rows, columns, sort)

  const caption = slots.caption
    ? slots.caption()
    : (props.caption ?? '') !== ''
      ? props.caption
      : null

  return (
    <table class="w-full border-collapse text-left">
      {caption === null ? null : (
        <caption class="pb-2 text-left text-sm text-[var(--color-muted-foreground)]">
          {caption}
        </caption>
      )}

      <thead>
        <tr>{columns.map((column) => renderHeaderCell(column, sort, slots, emit))}</tr>
      </thead>

      <tbody class="divide-y divide-[var(--color-border)]">
        {rows.length === 0 ? (
          <tr>
            {/* `colspan` never drops below 1: a table rendered with no
                columns still has to put the empty message somewhere. */}
            <td
              colspan={Math.max(columns.length, 1)}
              class="px-3 py-6 text-center text-sm text-[var(--color-muted-foreground)]"
            >
              {slots.empty ? slots.empty() : (props.emptyText ?? 'No rows to show')}
            </td>
          </tr>
        ) : (
          rows.map((row, rowIndex) => (
            <tr key={props.rowKey(row)} class="hover:bg-[var(--color-muted)]/40">
              {columns.map((column) => renderBodyCell(column, row, rowIndex, slots))}
            </tr>
          ))
        )}
      </tbody>

      {slots.footer ? (
        <tfoot class="border-t border-[var(--color-border)]">
          {slots.footer({ rows, columns })}
        </tfoot>
      ) : null}
    </table>
  )
}

/**
 * The runtime half of the declaration: which incoming keys are props rather
 * than fallthrough attributes. TypeScript takes the prop *types* from the
 * function signature above, so this only has to carry the names.
 *
 * Deliberately the name-list form and not the object form. An object
 * declaration is typed `ComponentPropsOptions<P>`, which pins `P` — every
 * consumer would then see the props as they look with `Row` already erased to
 * `unknown`, and passing a `ColumnDef<Invoice>[]` would not type-check. A
 * `string[]` mentions no type at all, so `Row` is still inferred from the call.
 *
 * The trade is runtime defaults and `required` warnings, which this form cannot
 * express. Defaults are applied in the function body instead — one place rather
 * than two — and TypeScript already rejects a call that omits a required prop.
 */
DataTable.props = ['rows', 'columns', 'rowKey', 'sort', 'caption', 'emptyText']

DataTable.emits = ['update:sort']

/**
 * Nuxt registers everything under `components/` for auto-import and resolves
 * each entry to that module's *default* export — a `.vue` file has one
 * implicitly, a `.tsx` file only if it says so. Without this line the generated
 * `components.d.ts` still declares `DataTable`, and the first page to rely on
 * the auto-import fails at build time with `"default" is not exported`, which
 * no gate short of `pnpm build` reaches.
 *
 * The named export above stays: it is what `DataTableSection` and the tests
 * import, and the only one of the two that can carry the type parameter.
 */
export default DataTable
