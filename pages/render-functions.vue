<script setup lang="ts">
import { computed, ref } from 'vue'

import { DataTableSection } from '../components/DataTableSection'
import { defineColumn } from '../utils/dataTable'

import type { ColumnDef, SortState } from '~/types/table'

definePageMeta({ layout: false })

/**
 * The table on this page is `components/DataTable.tsx` — a render function, not
 * a template — and everything below is here to make the difference visible
 * rather than assert it.
 *
 * Toggle a column off and the table is a different table. Nothing in the
 * component branches on which columns exist, because it never named one: it
 * maps over the array it was handed. The slots below are the other half —
 * `#cell:status` reaches a `<td>` in a component that has no idea a status
 * column is a thing, and it gets there through `DataTableSection`, which
 * forwards every slot it does not render itself.
 */

interface Invoice {
  id: string
  client: string
  amount: number
  status: 'draft' | 'sent' | 'paid'
  issued: Date
}

const INVOICES: readonly Invoice[] = [
  {
    id: 'INV-1041',
    client: 'Initech',
    amount: 4200,
    status: 'paid',
    issued: new Date('2026-01-14T00:00:00.000Z'),
  },
  {
    id: 'INV-1042',
    client: 'Acme Corp',
    amount: 890.5,
    status: 'sent',
    issued: new Date('2026-02-02T00:00:00.000Z'),
  },
  {
    id: 'INV-1043',
    client: 'Globex',
    amount: 15750,
    status: 'draft',
    issued: new Date('2026-02-11T00:00:00.000Z'),
  },
  {
    id: 'INV-1044',
    client: 'Hooli',
    amount: 890.5,
    status: 'paid',
    issued: new Date('2026-03-01T00:00:00.000Z'),
  },
  {
    id: 'INV-1045',
    client: 'Soylent',
    amount: 320,
    status: 'sent',
    issued: new Date('2026-03-09T00:00:00.000Z'),
  },
]

// Locales pinned so the page renders the same string on the server and in the
// browser. A currency formatted with the machine's locale is a hydration
// mismatch waiting for the first visitor in another region.
const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' })
const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC' })

/** Draft → sent → paid is the workflow order, which is not the alphabet. */
const STATUS_ORDER: readonly Invoice['status'][] = ['draft', 'sent', 'paid']

const ALL_COLUMNS: readonly ColumnDef<Invoice>[] = [
  defineColumn<Invoice, string>({
    id: 'client',
    header: 'Client',
    value: (row) => row.client,
  }),
  defineColumn<Invoice, number>({
    id: 'amount',
    header: 'Amount',
    value: (row) => row.amount,
    format: (amount) => money.format(amount),
    align: 'end',
  }),
  defineColumn<Invoice, Invoice['status']>({
    id: 'status',
    header: 'Status',
    value: (row) => row.status,
    // Without this the column would sort alphabetically — draft, paid, sent —
    // which reads like an order and is not one.
    compare: (a, b) => STATUS_ORDER.indexOf(a) - STATUS_ORDER.indexOf(b),
  }),
  defineColumn<Invoice, Date>({
    id: 'issued',
    header: 'Issued',
    value: (row) => row.issued,
    format: (issued) => day.format(issued),
  }),
  defineColumn<Invoice, string>({
    id: 'actions',
    header: 'Actions',
    value: (row) => row.id,
    // No order: a column of buttons has nothing to sort by, and a header that
    // offered to sort it would be a control that does nothing.
    sortable: false,
    align: 'end',
  }),
]

const hiddenColumnIds = ref<readonly string[]>([])

const columns = computed<readonly ColumnDef<Invoice>[]>(() =>
  ALL_COLUMNS.filter((column) => !hiddenColumnIds.value.includes(column.id)),
)

function toggleColumn(id: string): void {
  hiddenColumnIds.value = hiddenColumnIds.value.includes(id)
    ? hiddenColumnIds.value.filter((hidden) => hidden !== id)
    : [...hiddenColumnIds.value, id]
}

const query = ref('')

const rows = computed<readonly Invoice[]>(() => {
  const needle = query.value.trim().toLowerCase()
  if (needle === '') return INVOICES
  return INVOICES.filter((invoice) => invoice.client.toLowerCase().includes(needle))
})

// The page owns the sort, so it could be put in the URL, restored from a store,
// or shared with a second table. The component holds none of it.
const sort = ref<SortState | null>({ columnId: 'issued', direction: 'descending' })

const rowKey = (invoice: Invoice): string => invoice.id

// `DataTableSection` is generic over its row type, and a template cannot supply
// a type argument. Binding it once here — a TypeScript instantiation
// expression, which produces the same function object at runtime — is what
// makes `row` below an `Invoice` rather than `unknown` in every slot scope.
const InvoiceSection = DataTableSection<Invoice>

const STATUS_CLASSES: Record<Invoice['status'], string> = {
  draft: 'bg-[var(--color-muted)] text-[var(--color-muted-foreground)]',
  sent: 'bg-amber-500/15 text-amber-700 dark:text-amber-400',
  paid: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
}

const paidTotal = computed(() =>
  money.format(
    rows.value
      .filter((invoice) => invoice.status === 'paid')
      .reduce((total, invoice) => total + invoice.amount, 0),
  ),
)
</script>

<template>
  <div class="min-h-screen bg-[var(--color-background)] p-8">
    <div class="mx-auto max-w-4xl space-y-6">
      <header class="space-y-2">
        <h1 class="text-2xl font-bold text-[var(--color-foreground)]">
          Render functions &amp; JSX
        </h1>
        <p class="text-sm text-[var(--color-muted-foreground)]">
          <code class="font-mono">components/DataTable.tsx</code> renders a column list, not a fixed
          set of columns, and looks up a <code class="font-mono">cell:&lt;id&gt;</code> slot per
          cell. <code class="font-mono">components/DataTableSection.tsx</code> wraps it and forwards
          every slot it does not render itself, so the slots below reach the table through a
          component that never names them.
        </p>
      </header>

      <section
        class="space-y-4 rounded-xl border border-[var(--color-border)] bg-[var(--color-muted)] p-6"
      >
        <div class="space-y-2">
          <h2 class="text-sm font-semibold text-[var(--color-foreground)]">Columns</h2>
          <div class="flex flex-wrap gap-2">
            <button
              v-for="column in ALL_COLUMNS"
              :key="column.id"
              type="button"
              class="rounded-md border px-3 py-1.5 text-sm font-medium"
              :class="
                hiddenColumnIds.includes(column.id)
                  ? 'border-[var(--color-border)] bg-[var(--color-background)] text-[var(--color-muted-foreground)]'
                  : 'border-[var(--color-primary)] bg-[var(--color-primary)] text-[var(--color-primary-foreground)]'
              "
              :aria-pressed="!hiddenColumnIds.includes(column.id)"
              @click="toggleColumn(column.id)"
            >
              {{ column.header }}
            </button>
          </div>
        </div>

        <div class="space-y-1">
          <label for="client-filter" class="text-sm font-semibold text-[var(--color-foreground)]">
            Filter by client
          </label>
          <input
            id="client-filter"
            v-model="query"
            type="search"
            placeholder="Try “zzz” for the empty state"
            class="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-background)] px-3 py-2 text-sm text-[var(--color-foreground)]"
          />
        </div>

        <p class="text-xs text-[var(--color-muted-foreground)]">
          Sorted by:
          <code class="font-mono">{{
            sort === null ? 'nothing' : `${sort.columnId} ${sort.direction}`
          }}</code>
          — click a header to cycle ascending → descending → unsorted.
        </p>
      </section>

      <!-- Every slot here is written against `DataTableSection`, and every one
           of them except `#title` is rendered by `DataTable`, one component
           further down. -->
      <InvoiceSection
        v-model:sort="sort"
        title="Invoices"
        description="Columns are data; the component maps over whatever it is given."
        :rows="rows"
        :columns="columns"
        :row-key="rowKey"
      >
        <template #header:amount="{ sorted, toggle }">
          <button
            type="button"
            class="inline-flex items-center gap-1 rounded uppercase hover:text-[var(--color-foreground)]"
            @click="toggle"
          >
            Amount (USD)
            <span aria-hidden="true" :class="sorted === null ? 'opacity-40' : ''">
              {{ sorted === 'ascending' ? '↑' : sorted === 'descending' ? '↓' : '↕' }}
            </span>
          </button>
        </template>

        <template #cell:status="{ row }">
          <span
            class="inline-flex rounded-full px-2 py-0.5 text-xs font-medium capitalize"
            :class="STATUS_CLASSES[row.status]"
          >
            {{ row.status }}
          </span>
        </template>

        <template #cell:actions="{ row }">
          <button
            type="button"
            class="rounded px-2 py-1 text-xs font-medium text-[var(--color-primary)] hover:bg-[var(--color-primary)]/10"
            :aria-label="`Open ${row.id}`"
          >
            Open
          </button>
        </template>

        <template #empty>
          <p class="text-sm text-[var(--color-muted-foreground)]">
            No invoice matches “{{ query }}”.
          </p>
        </template>

        <template #footer="{ columns: shown }">
          <tr>
            <td
              :colspan="shown.length"
              class="px-3 py-2 text-right text-xs text-[var(--color-muted-foreground)]"
            >
              Paid to date: {{ paidTotal }}
            </td>
          </tr>
        </template>
      </InvoiceSection>

      <section
        class="space-y-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-muted)] p-6 text-sm text-[var(--color-foreground)]"
      >
        <h2 class="text-lg font-semibold">What is actually wired</h2>
        <pre
          class="overflow-x-auto rounded-md bg-[var(--color-background)] p-4 font-mono text-xs text-[var(--color-muted-foreground)]"
        ><code>// components/DataTable.tsx — one cell, three sources, one expression
const slot = slots[`cell:${column.id}`]
return &lt;td&gt;{slot ? slot({ row, rowIndex, column, text }) : text}&lt;/td&gt;

// components/DataTableSection.tsx — the wrapper names one slot and passes the rest
h(DataTable&lt;Row&gt;, tableProps, forwardSlots(slots, { except: ['title'] }))</code></pre>
        <p class="text-[var(--color-muted-foreground)]">
          See <code class="font-mono">docs/render-functions.md</code> for when this trade is worth
          making — and when a template is still the better answer.
        </p>
      </section>
    </div>
  </div>
</template>
