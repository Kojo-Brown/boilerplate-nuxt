import { h } from 'vue'
import type { SetupContext, SlotsType, VNode } from 'vue'

import { forwardSlots } from '../utils/slots'

import { DataTable } from './DataTable'
import type { DataTableEmits } from './DataTable'

import type { ColumnDef, DataTableSlots, SortState } from '~/types/table'

/**
 * A titled section wrapping a {@link DataTable}, and the reason
 * {@link forwardSlots} exists.
 *
 * The chrome is deliberately boring — a heading, a row count, a border — because
 * the interesting part is what the wrapper does *not* do. It renders one slot
 * itself (`title`) and passes every other slot straight through to the table
 * below it, without naming any of them. Add a column to a table on some page
 * and pass `#cell:newColumn`, and it arrives; this file does not change, and
 * did not have to know the column existed.
 *
 * The same wrapper written as a template would need a `<template #x>` for every
 * slot `DataTable` accepts. It cannot: the names are `cell:<column id>`, so the
 * set is open, and any slot this file failed to list would be accepted by the
 * wrapper and then quietly dropped — the parent passes it, no error is raised,
 * and nothing renders.
 */

/** The props `DataTableSection` renders from. */
export interface DataTableSectionProps<Row> {
  /** Heading text. The `title` slot overrides it — and is not forwarded. */
  title: string
  /** Optional supporting line under the heading. */
  description?: string
  rows: readonly Row[]
  columns: readonly ColumnDef<Row>[]
  rowKey: (row: Row) => string | number
  /** Pass through to the table. `v-model:sort` works on the section too. */
  sort?: SortState | null
}

/**
 * Every slot the table has, plus the one the section owns.
 *
 * The intersection is the type-level half of the forwarding contract: the
 * section's slots are a superset of the table's, so passing the forwarded
 * object down type-checks precisely because nothing was lost on the way.
 */
export type DataTableSectionSlots<Row> = DataTableSlots<Row> & {
  /** Replaces the heading. Rendered here, so it is never forwarded onward. */
  title?: () => VNode[]
}

/** As in `DataTable.tsx`: a functional component's context has no `expose`. */
type SectionContext<Row> = Omit<
  SetupContext<DataTableEmits, SlotsType<DataTableSectionSlots<Row>>>,
  'expose'
>

export function DataTableSection<Row>(
  props: DataTableSectionProps<Row>,
  { slots, emit }: SectionContext<Row>,
): VNode {
  return (
    <section class="rounded-lg border border-[var(--color-border)] p-4">
      <header class="mb-3 flex items-baseline justify-between gap-4">
        <div>
          <h3 class="text-sm font-semibold text-[var(--color-foreground)]">
            {slots.title ? slots.title() : props.title}
          </h3>
          {props.description === undefined ? null : (
            <p class="mt-1 text-xs text-[var(--color-muted-foreground)]">{props.description}</p>
          )}
        </div>
        <p class="text-xs whitespace-nowrap text-[var(--color-muted-foreground)]">
          {props.rows.length} {props.rows.length === 1 ? 'row' : 'rows'}
        </p>
      </header>

      {/* `h()` rather than `<DataTable v-slots={…} />`. JSX compiles to this
        call anyway, and when the slots are a computed object the call says so
        directly — but it is also the only portable spelling: `v-slots` is a
        feature of the Babel JSX plugin, which the app builds with and the test
        run does not (see `vitest.config.ts`). `h()` means both transforms
        produce the same thing. The forwarded object is read live on every
        access, so building it here — once per render — is not a snapshot. */}
      {h(
        // `DataTable<Row>` rather than `DataTable`: TypeScript will not infer a
        // type parameter *through* a generic function passed as an argument, so
        // without the instantiation the child is checked at `Row = unknown` and
        // this wrapper's own columns stop fitting it. See
        // `docs/render-functions.md`.
        DataTable<Row>,
        {
          rows: props.rows,
          columns: props.columns,
          rowKey: props.rowKey,
          sort: props.sort ?? null,
          'onUpdate:sort': (sort: SortState | null) => {
            emit('update:sort', sort)
          },
        },
        forwardSlots(slots, { except: ['title'] }),
      )}
    </section>
  )
}

/** See `DataTable.tsx` for why this is a name list and not an object. */
DataTableSection.props = ['title', 'description', 'rows', 'columns', 'rowKey', 'sort']

DataTableSection.emits = ['update:sort']

/** See `DataTable.tsx`: Nuxt's auto-import resolves to the default export. */
export default DataTableSection
