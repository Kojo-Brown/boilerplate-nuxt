import { createSSRApp, h } from 'vue'
import type { VNode } from 'vue'
import { renderToString } from 'vue/server-renderer'
import { describe, it, expect, vi } from 'vitest'

import { DataTable } from '../../../components/DataTable'
import { DataTableSection } from '../../../components/DataTableSection'
import { defineColumn } from '../../../utils/dataTable'

import type { CellScope, ColumnDef, HeaderScope, SortState } from '~/types/table'

/**
 * What the render function actually renders.
 *
 * `renderToString` rather than a DOM mount, for the same reason the rest of
 * this suite uses it: the unit suite runs in the `node` environment, and SSR is
 * where a Nuxt component has to be correct first. The trade-off is that nothing
 * here can click — so the sort *control* is exercised through the header slot's
 * `toggle`, and the ordering it produces is covered by
 * `tests/unit/utils/dataTable.test.ts`.
 */

interface Invoice {
  id: string
  client: string
  amount: number
  paid: boolean
}

const rows: readonly Invoice[] = [
  { id: 'inv-1', client: 'Initech', amount: 300, paid: false },
  { id: 'inv-2', client: 'Acme', amount: 100, paid: true },
]

const columns: readonly ColumnDef<Invoice>[] = [
  defineColumn<Invoice, string>({ id: 'client', header: 'Client', value: (row) => row.client }),
  defineColumn<Invoice, number>({
    id: 'amount',
    header: 'Amount',
    value: (row) => row.amount,
    format: (amount) => `$${amount}`,
    align: 'end',
  }),
  defineColumn<Invoice, boolean>({
    id: 'actions',
    header: 'Actions',
    value: (row) => row.paid,
    sortable: false,
  }),
]

const rowKey = (row: Invoice): string => row.id

// Both components are generic over the row type, and TypeScript cannot infer
// that parameter through `h()`. Binding it once here is what gives every
// assertion below a typed `row` in its slot scopes — see
// `docs/render-functions.md`.
const InvoiceTable = DataTable<Invoice>
const InvoiceSection = DataTableSection<Invoice>

function render(factory: () => VNode): Promise<string> {
  return renderToString(createSSRApp({ render: factory }))
}

/** The text of every `<td>`, in document order, with markup and comments removed. */
function cellTexts(html: string): string[] {
  return [...html.matchAll(/<td[^>]*>(.*?)<\/td>/gs)].map((match) =>
    (match[1] ?? '').replace(/<!--.*?-->/gs, '').replace(/<[^>]*>/g, ''),
  )
}

/** The text of every `<th>`, in document order. */
function headerTexts(html: string): string[] {
  return [...html.matchAll(/<th(?=[\s>])[^>]*>(.*?)<\/th>/gs)].map((match) =>
    (match[1] ?? '')
      .replace(/<!--.*?-->/gs, '')
      .replace(/<[^>]*>/g, '')
      .trim(),
  )
}

describe('DataTable', () => {
  it('renders one header and one cell per column, in column order', async () => {
    const html = await render(() => h(InvoiceTable, { rows, columns, rowKey }))

    expect(headerTexts(html)).toEqual(['Client↕', 'Amount↕', 'Actions'])
    expect(cellTexts(html)).toEqual(['Initech', '$300', 'false', 'Acme', '$100', 'true'])
  })

  it('renders the column list it is given, not one baked into the markup', async () => {
    // The claim that makes this a render function: drop a column and the table
    // is a different table, with no branch anywhere in the component.
    const html = await render(() => h(InvoiceTable, { rows, columns: columns.slice(0, 1), rowKey }))

    expect(headerTexts(html)).toEqual(['Client↕'])
    expect(cellTexts(html)).toEqual(['Initech', 'Acme'])
  })

  it('offers a sort control only on sortable columns', async () => {
    const html = await render(() => h(InvoiceTable, { rows, columns, rowKey }))
    const headers = [...html.matchAll(/<th(?=[\s>])[^>]*>.*?<\/th>/gs)].map((match) => match[0])

    expect(headers[0]).toContain('<button')
    expect(headers[2]).not.toContain('<button')
  })

  it('marks the sorted column with aria-sort, and the rest with none', async () => {
    const html = await render(() =>
      h(InvoiceTable, {
        rows,
        columns,
        rowKey,
        sort: { columnId: 'amount', direction: 'descending' },
      }),
    )
    const headers = [...html.matchAll(/<th(?=[\s>])[^>]*>/g)].map((match) => match[0])

    // 'none' rather than a missing attribute: "sortable and not currently
    // sorted" is different information from "this column has no order".
    expect(headers[0]).toContain('aria-sort="none"')
    expect(headers[1]).toContain('aria-sort="descending"')
    expect(headers[2]).not.toContain('aria-sort')
  })

  it('displays rows in the order the sort prop asks for', async () => {
    const html = await render(() =>
      h(InvoiceTable, {
        rows,
        columns,
        rowKey,
        sort: { columnId: 'client', direction: 'ascending' },
      }),
    )

    expect(cellTexts(html)).toEqual(['Acme', '$100', 'true', 'Initech', '$300', 'false'])
  })

  it('lets a cell slot replace one column and leaves the others alone', async () => {
    const html = await render(() =>
      h(
        InvoiceTable,
        { rows, columns, rowKey },
        {
          'cell:actions': (scope: CellScope<Invoice>) => [
            h('button', { type: 'button' }, `Pay ${scope.row.id}`),
          ],
        },
      ),
    )

    expect(html).toContain('Pay inv-1')
    expect(html).toContain('Pay inv-2')
    expect(cellTexts(html)).toEqual(['Initech', '$300', 'Pay inv-1', 'Acme', '$100', 'Pay inv-2'])
  })

  it('gives a cell slot the row, its displayed index, the column, and the default text', async () => {
    const scopes: CellScope<Invoice>[] = []

    await render(() =>
      h(
        InvoiceTable,
        { rows, columns, rowKey, sort: { columnId: 'client', direction: 'ascending' } },
        {
          'cell:amount': (scope: CellScope<Invoice>) => {
            scopes.push(scope)
            return [h('span', scope.text)]
          },
        },
      ),
    )

    // `rowIndex` follows the sort, not the input array: Acme sorts first.
    expect(scopes.map((scope) => [scope.row.id, scope.rowIndex, scope.text])).toEqual([
      ['inv-2', 0, '$100'],
      ['inv-1', 1, '$300'],
    ])
    expect(scopes[0]?.column.id).toBe('amount')
  })

  it('lets a header slot drive the same sort state machine as the default control', async () => {
    const emitted: (SortState | null)[] = []

    await render(() =>
      h(
        InvoiceTable,
        {
          rows,
          columns,
          rowKey,
          sort: { columnId: 'client', direction: 'ascending' },
          'onUpdate:sort': (sort: SortState | null) => {
            emitted.push(sort)
          },
        },
        {
          // Calling `toggle` from a render is not how a user does it, but it is
          // the only way to press the control without a DOM — and it asserts
          // the thing worth asserting: a custom header advances the *same*
          // state, rather than a copy of the logic that can drift from it.
          'header:client': (scope: HeaderScope<Invoice>) => {
            scope.toggle()
            return [h('span', `Client (${scope.sorted ?? 'unsorted'})`)]
          },
        },
      ),
    )

    expect(emitted).toEqual([{ columnId: 'client', direction: 'descending' }])
  })

  it('tells a header slot its own direction and nothing about other columns', async () => {
    const seen: (string | null)[] = []

    await render(() =>
      h(
        InvoiceTable,
        { rows, columns, rowKey, sort: { columnId: 'amount', direction: 'ascending' } },
        {
          'header:client': (scope: HeaderScope<Invoice>) => {
            seen.push(scope.sorted)
            return [h('span', 'Client')]
          },
          'header:amount': (scope: HeaderScope<Invoice>) => {
            seen.push(scope.sorted)
            return [h('span', 'Amount')]
          },
        },
      ),
    )

    expect(seen).toEqual([null, 'ascending'])
  })

  it('shows the empty text instead of rows, spanning every column', async () => {
    const html = await render(() =>
      h(InvoiceTable, { rows: [], columns, rowKey, emptyText: 'No invoices yet' }),
    )

    expect(html).toContain('No invoices yet')
    expect(html).toContain('colspan="3"')
  })

  it('lets the empty slot replace the empty text', async () => {
    const html = await render(() =>
      h(
        InvoiceTable,
        { rows: [], columns, rowKey, emptyText: 'No invoices yet' },
        { empty: () => [h('p', 'Nothing to bill.')] },
      ),
    )

    expect(html).toContain('Nothing to bill.')
    expect(html).not.toContain('No invoices yet')
  })

  it('renders a caption from the prop, and lets the slot override it', async () => {
    const fromProp = await render(() =>
      h(InvoiceTable, { rows, columns, rowKey, caption: 'Q1 invoices' }),
    )
    expect(fromProp).toContain('<caption')
    expect(fromProp).toContain('Q1 invoices')

    const fromSlot = await render(() =>
      h(
        InvoiceTable,
        { rows, columns, rowKey, caption: 'Q1 invoices' },
        { caption: () => [h('strong', 'Overridden')] },
      ),
    )
    expect(fromSlot).toContain('Overridden')
    expect(fromSlot).not.toContain('Q1 invoices')
  })

  it('omits the caption and the footer entirely when neither is asked for', async () => {
    const html = await render(() => h(InvoiceTable, { rows, columns, rowKey }))

    expect(html).not.toContain('<caption')
    expect(html).not.toContain('<tfoot')
  })

  it('gives the footer slot the rows as displayed and the columns', async () => {
    const html = await render(() =>
      h(
        InvoiceTable,
        { rows, columns, rowKey, sort: { columnId: 'amount', direction: 'ascending' } },
        {
          footer: (scope: { rows: readonly Invoice[]; columns: readonly ColumnDef<Invoice>[] }) => [
            h('tr', [
              h(
                'td',
                { colspan: scope.columns.length },
                `Total $${scope.rows.reduce((sum, row) => sum + row.amount, 0)}, first ${scope.rows[0]?.client}`,
              ),
            ]),
          ],
        },
      ),
    )

    expect(html).toContain('<tfoot')
    expect(html).toContain('Total $400, first Acme')
  })
})

describe('DataTableSection', () => {
  it('renders its own chrome around the table', async () => {
    const html = await render(() =>
      h(InvoiceSection, {
        title: 'Invoices',
        description: 'Everything unpaid',
        rows,
        columns,
        rowKey,
      }),
    )

    expect(html).toContain('Invoices')
    expect(html).toContain('Everything unpaid')
    expect(html).toContain('2 rows')
    expect(cellTexts(html)).toEqual(['Initech', '$300', 'false', 'Acme', '$100', 'true'])
  })

  it('agrees with itself about singular and plural row counts', async () => {
    const html = await render(() =>
      h(InvoiceSection, { title: 'Invoices', rows: rows.slice(0, 1), columns, rowKey }),
    )

    expect(html).toContain('1 row')
    expect(html).not.toContain('1 rows')
  })

  it('forwards a cell slot through to the table it wraps', async () => {
    // The point of the wrapper: `DataTableSection` names no slot but `title`,
    // and `cell:actions` still arrives at the table underneath it.
    const html = await render(() =>
      h(
        InvoiceSection,
        { title: 'Invoices', rows, columns, rowKey },
        {
          'cell:actions': (scope: CellScope<Invoice>) => [h('span', `Pay ${scope.row.id}`)],
        },
      ),
    )

    expect(cellTexts(html)).toEqual(['Initech', '$300', 'Pay inv-1', 'Acme', '$100', 'Pay inv-2'])
  })

  it('forwards header, empty and footer slots too, without naming any of them', async () => {
    const withRows = await render(() =>
      h(
        InvoiceSection,
        { title: 'Invoices', rows, columns, rowKey },
        {
          'header:client': () => [h('span', 'Customer')],
          footer: () => [h('tr', [h('td', 'Summed elsewhere')])],
        },
      ),
    )

    expect(headerTexts(withRows)).toEqual(['Customer', 'Amount↕', 'Actions'])
    expect(withRows).toContain('Summed elsewhere')

    const withoutRows = await render(() =>
      h(
        InvoiceSection,
        { title: 'Invoices', rows: [], columns, rowKey },
        { empty: () => [h('p', 'Nothing to bill.')] },
      ),
    )

    expect(withoutRows).toContain('Nothing to bill.')
  })

  it('renders the title slot itself rather than passing it down', async () => {
    const title = vi.fn(() => [h('em', 'Overdue invoices')])

    const html = await render(() =>
      h(InvoiceSection, { title: 'Invoices', rows, columns, rowKey }, { title }),
    )

    expect(html).toContain('<em>Overdue invoices</em>')
    expect(html).not.toContain('>Invoices<')
    // Rendered once, in the heading. The table below is never given a chance
    // to render it a second time.
    expect(title).toHaveBeenCalledTimes(1)
  })

  it("re-emits the table's sort changes so v-model:sort works on the section", async () => {
    const emitted: (SortState | null)[] = []

    await render(() =>
      h(
        InvoiceSection,
        {
          title: 'Invoices',
          rows,
          columns,
          rowKey,
          sort: { columnId: 'amount', direction: 'ascending' },
          'onUpdate:sort': (sort: SortState | null) => {
            emitted.push(sort)
          },
        },
        {
          'header:amount': (scope: HeaderScope<Invoice>) => {
            scope.toggle()
            return [h('span', 'Amount')]
          },
        },
      ),
    )

    expect(emitted).toEqual([{ columnId: 'amount', direction: 'descending' }])
  })

  it('passes the sort prop down, so the wrapped table is really sorted', async () => {
    const html = await render(() =>
      h(InvoiceSection, {
        title: 'Invoices',
        rows,
        columns,
        rowKey,
        sort: { columnId: 'client', direction: 'ascending' },
      }),
    )

    expect(cellTexts(html)).toEqual(['Acme', '$100', 'true', 'Initech', '$300', 'false'])
  })
})
