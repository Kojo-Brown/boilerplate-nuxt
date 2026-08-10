<script setup lang="ts">
import { computed, isReactive, markRaw, nextTick, reactive, ref, shallowRef } from 'vue'

definePageMeta({ layout: false })

// ─── PAYLOAD ─────────────────────────────────────────────────────────────────
// A row shape big enough to be worth caring about: 20k of these is the point
// where deep reactivity stops being free.

interface MetricRow {
  id: string
  region: string
  requests: number
  p95: number
}

const REGIONS = ['eu-west-1', 'us-east-1', 'ap-south-1', 'sa-east-1'] as const

function buildRows(count: number, prefix = 'row'): MetricRow[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `${prefix}-${i}`,
    region: REGIONS[i % REGIONS.length] ?? 'eu-west-1',
    requests: (i * 37) % 9_000,
    p95: Number(((i % 250) / 10 + 12).toFixed(1)),
  }))
}

const rowCount = ref(20_000)
const ROW_COUNT_CHOICES = [5_000, 20_000, 50_000] as const

// ─── 1. shallowRef vs deep ref ───────────────────────────────────────────────
// Both legs build the same payload and then read one property off every row.
// The read matters: `ref()` converts lazily, so a benchmark that only assigns
// and never touches the rows measures nothing and flatters deep reactivity.

interface BenchResult {
  rows: number
  deepRefMs: number
  shallowRefMs: number
  proxiedMapMs: number
  rawMapMs: number
  /** Kept and rendered so the read loops cannot be optimised away. */
  checksum: number
}

// The result is a leaf object that is replaced wholesale — exactly the case
// `shallowRef` exists for, so the page practises what it documents.
const bench = shallowRef<BenchResult | null>(null)
const benchRunning = ref(false)

function measure(fn: () => number): { ms: number; checksum: number } {
  const start = performance.now()
  const checksum = fn()
  return { ms: performance.now() - start, checksum }
}

async function runBenchmark(): Promise<void> {
  benchRunning.value = true
  // Let the button repaint before the main thread is blocked.
  await nextTick()

  const n = rowCount.value

  // Independent payloads so neither leg runs against a warmed object graph.
  const deepPayload = buildRows(n, 'deep')
  const shallowPayload = buildRows(n, 'shallow')

  const deep = measure(() => {
    const state = ref(deepPayload)
    let sum = 0
    // Every element access here mints a Proxy for that row.
    for (const row of state.value) sum += row.requests
    return sum
  })

  const shallow = measure(() => {
    const state = shallowRef(shallowPayload)
    let sum = 0
    // Same reads, plain objects — no traps on the path.
    for (const row of state.value) sum += row.requests
    return sum
  })

  // The same question for the lookup structure that sits beside the rows.
  const entries: [string, MetricRow][] = shallowPayload.map((row) => [row.id, row])

  const proxied = measure(() => {
    const holder = reactive({ index: new Map(entries) })
    let sum = 0
    for (const [id] of entries) sum += holder.index.get(id)?.requests ?? 0
    return sum
  })

  const raw = measure(() => {
    const holder = reactive({ index: markRaw(new Map(entries)) })
    let sum = 0
    for (const [id] of entries) sum += holder.index.get(id)?.requests ?? 0
    return sum
  })

  bench.value = {
    rows: n,
    deepRefMs: deep.ms,
    shallowRefMs: shallow.ms,
    proxiedMapMs: proxied.ms,
    rawMapMs: raw.ms,
    checksum: deep.checksum,
  }
  benchRunning.value = false
}

function speedup(slower: number, faster: number): string {
  if (faster <= 0) return '—'
  return `${(slower / faster).toFixed(1)}×`
}

function ms(value: number): string {
  return `${value.toFixed(1)} ms`
}

// ─── 2. triggerRef ───────────────────────────────────────────────────────────
// useLargeCollection keeps the rows in a shallowRef. Editing a row is therefore
// invisible until something publishes it — which is the whole bargain.

const collection = useLargeCollection<MetricRow>({ key: (row) => row.id })
const uncommittedEdits = ref(0)

// Only a window is rendered; nobody paints 20k <tr>s.
const visibleRows = computed(() => collection.items.value.slice(0, 6))

function loadRows(): void {
  collection.replaceAll(buildRows(rowCount.value, 'live'))
  uncommittedEdits.value = 0
}

/** Mutates the row object directly, without telling Vue. The table will not move. */
function editWithoutCommitting(): void {
  const first = collection.items.value[0]
  if (!first) return
  first.requests += 1_000
  uncommittedEdits.value += 1
}

/** A no-op mutation whose only job is the `triggerRef` at the end of it. */
function commitEdits(): void {
  collection.mutate(() => {})
  uncommittedEdits.value = 0
}

/** The supported path: edit and publish in one call. */
function patchFirstRow(): void {
  const first = collection.items.value[0]
  if (!first) return
  collection.patch(first.id, { p95: Number((first.p95 + 1.5).toFixed(1)) })
}

function appendBatch(): void {
  collection.append(buildRows(500, `batch-${collection.revision.value}`))
}

// ─── 3. markRaw ──────────────────────────────────────────────────────────────
// Proof rather than assertion: the collection's index is not a proxy, and an
// unmarked Map in the same position would have been one.

const indexIsReactive = computed(() => isReactive(collection.index))
const unmarkedMapIsReactive = isReactive(reactive({ index: new Map<string, MetricRow>() }).index)
</script>

<template>
  <div class="min-h-screen bg-[var(--color-background)] p-6">
    <div class="mx-auto max-w-3xl space-y-8">
      <header>
        <h1 class="text-2xl font-bold text-[var(--color-foreground)]">
          Reactivity for Large Payloads
        </h1>
        <p class="mt-1 text-sm text-[var(--color-muted-foreground)]">
          <code>shallowRef</code> to stop deep tracking, <code>triggerRef</code> to publish in-place
          edits, and <code>markRaw</code> to keep heavy structures out of the reactivity system.
        </p>
      </header>

      <!-- ── Payload size ── -->
      <section class="rounded-xl border border-[var(--color-border)] bg-[var(--color-muted)] p-6">
        <h2 class="text-lg font-semibold text-[var(--color-foreground)]">Payload size</h2>
        <p class="mt-0.5 text-xs text-[var(--color-muted-foreground)]">
          Applies to both the benchmark and the live collection below.
        </p>

        <div class="mt-4 flex flex-wrap gap-2">
          <button
            v-for="choice in ROW_COUNT_CHOICES"
            :key="choice"
            class="rounded-md border px-3 py-1 text-xs font-medium"
            :class="
              rowCount === choice
                ? 'border-transparent bg-[var(--color-primary)] text-[var(--color-primary-foreground)]'
                : 'border-[var(--color-border)] bg-[var(--color-background)] text-[var(--color-foreground)] hover:bg-[var(--color-muted)]'
            "
            @click="rowCount = choice"
          >
            {{ choice.toLocaleString('en-US') }} rows
          </button>
        </div>
      </section>

      <!-- ── 1. shallowRef ── -->
      <section class="rounded-xl border border-[var(--color-border)] bg-[var(--color-muted)] p-6">
        <div class="mb-4 flex items-start justify-between gap-4">
          <div>
            <h2 class="text-lg font-semibold text-[var(--color-foreground)]">
              1 · <code>shallowRef</code> vs deep <code>ref</code>
            </h2>
            <p class="mt-0.5 text-xs text-[var(--color-muted-foreground)]">
              Same payload, same reads. <code>ref()</code> installs one Proxy per row on first
              access; <code>shallowRef()</code> tracks only reassignment of <code>.value</code>.
            </p>
          </div>

          <button
            class="shrink-0 rounded-md bg-[var(--color-primary)] px-3 py-1 text-xs font-medium text-[var(--color-primary-foreground)] hover:opacity-90 disabled:opacity-50"
            :disabled="benchRunning"
            @click="runBenchmark()"
          >
            {{ benchRunning ? 'Measuring…' : 'Run benchmark' }}
          </button>
        </div>

        <p v-if="!bench" class="text-sm text-[var(--color-muted-foreground)]">
          Runs on the client, on this machine. Numbers vary by device — the ratio is the point, not
          the absolute figures.
        </p>

        <table v-else class="w-full text-left text-sm">
          <thead class="text-xs text-[var(--color-muted-foreground)] uppercase">
            <tr>
              <th class="py-2">Case</th>
              <th class="py-2">Deep</th>
              <th class="py-2">Shallow / raw</th>
              <th class="py-2">Speedup</th>
            </tr>
          </thead>
          <tbody class="text-[var(--color-foreground)]">
            <tr class="border-t border-[var(--color-border)]">
              <td class="py-2">
                {{ bench.rows.toLocaleString('en-US') }} rows, read <code>requests</code>
              </td>
              <td class="py-2 tabular-nums">{{ ms(bench.deepRefMs) }}</td>
              <td class="py-2 tabular-nums">{{ ms(bench.shallowRefMs) }}</td>
              <td class="py-2 font-semibold tabular-nums">
                {{ speedup(bench.deepRefMs, bench.shallowRefMs) }}
              </td>
            </tr>
            <tr class="border-t border-[var(--color-border)]">
              <td class="py-2">
                Same-size <code>Map</code> in <code>reactive()</code>, one <code>get()</code> per
                entry
              </td>
              <td class="py-2 tabular-nums">{{ ms(bench.proxiedMapMs) }}</td>
              <td class="py-2 tabular-nums">{{ ms(bench.rawMapMs) }}</td>
              <td class="py-2 font-semibold tabular-nums">
                {{ speedup(bench.proxiedMapMs, bench.rawMapMs) }}
              </td>
            </tr>
          </tbody>
        </table>

        <p v-if="bench" class="mt-3 text-xs text-[var(--color-muted-foreground)]">
          Checksum {{ bench.checksum.toLocaleString('en-US') }} — rendered so the read loops are not
          dead code.
        </p>
      </section>

      <!-- ── 2. triggerRef ── -->
      <section class="rounded-xl border border-[var(--color-border)] bg-[var(--color-muted)] p-6">
        <div class="mb-4">
          <h2 class="text-lg font-semibold text-[var(--color-foreground)]">
            2 · <code>triggerRef</code>
          </h2>
          <p class="mt-0.5 text-xs text-[var(--color-muted-foreground)]">
            Rows in a <code>shallowRef</code> are plain objects. Mutating one changes the data and
            nothing else — the render only catches up on an explicit commit.
          </p>
        </div>

        <div class="mb-4 flex flex-wrap gap-2">
          <button
            class="rounded-md bg-[var(--color-primary)] px-3 py-1 text-xs font-medium text-[var(--color-primary-foreground)] hover:opacity-90"
            @click="loadRows()"
          >
            Load {{ rowCount.toLocaleString('en-US') }} rows
          </button>
          <button
            class="rounded-md border border-[var(--color-border)] bg-[var(--color-background)] px-3 py-1 text-xs font-medium text-[var(--color-foreground)] hover:bg-[var(--color-muted)] disabled:opacity-50"
            :disabled="collection.size.value === 0"
            @click="editWithoutCommitting()"
          >
            Edit row 0 without committing
          </button>
          <button
            class="rounded-md border border-[var(--color-border)] bg-[var(--color-background)] px-3 py-1 text-xs font-medium text-[var(--color-foreground)] hover:bg-[var(--color-muted)] disabled:opacity-50"
            :disabled="uncommittedEdits === 0"
            @click="commitEdits()"
          >
            Commit ({{ uncommittedEdits }} pending)
          </button>
          <button
            class="rounded-md border border-[var(--color-border)] bg-[var(--color-background)] px-3 py-1 text-xs font-medium text-[var(--color-foreground)] hover:bg-[var(--color-muted)] disabled:opacity-50"
            :disabled="collection.size.value === 0"
            @click="patchFirstRow()"
          >
            patch() row 0
          </button>
          <button
            class="rounded-md border border-[var(--color-border)] bg-[var(--color-background)] px-3 py-1 text-xs font-medium text-[var(--color-foreground)] hover:bg-[var(--color-muted)] disabled:opacity-50"
            :disabled="collection.size.value === 0"
            @click="appendBatch()"
          >
            Append 500
          </button>
        </div>

        <div class="mb-3 flex flex-wrap gap-4 text-xs text-[var(--color-muted-foreground)]">
          <span
            >rows:
            <strong class="tabular-nums">{{
              collection.size.value.toLocaleString('en-US')
            }}</strong></span
          >
          <span
            >revision: <strong class="tabular-nums">{{ collection.revision.value }}</strong></span
          >
          <span
            >uncommitted edits: <strong class="tabular-nums">{{ uncommittedEdits }}</strong></span
          >
        </div>

        <p
          v-if="uncommittedEdits > 0"
          class="mb-3 rounded-md bg-amber-100 px-3 py-2 text-xs text-amber-900 dark:bg-amber-900/40 dark:text-amber-200"
        >
          Row 0 has {{ uncommittedEdits }} unpublished edit(s). The table below still shows the old
          value — that is <code>shallowRef</code> behaving correctly, not a bug. Commit to publish.
        </p>

        <p v-if="collection.size.value === 0" class="text-sm text-[var(--color-muted-foreground)]">
          No rows loaded yet.
        </p>

        <table v-else class="w-full text-left text-sm">
          <thead class="text-xs text-[var(--color-muted-foreground)] uppercase">
            <tr>
              <th class="py-2">id</th>
              <th class="py-2">region</th>
              <th class="py-2">requests</th>
              <th class="py-2">p95</th>
            </tr>
          </thead>
          <tbody class="text-[var(--color-foreground)]">
            <tr
              v-for="row in visibleRows"
              :key="row.id"
              class="border-t border-[var(--color-border)]"
            >
              <td class="py-1.5 font-mono text-xs">{{ row.id }}</td>
              <td class="py-1.5">{{ row.region }}</td>
              <td class="py-1.5 tabular-nums">{{ row.requests.toLocaleString('en-US') }}</td>
              <td class="py-1.5 tabular-nums">{{ row.p95 }}</td>
            </tr>
          </tbody>
        </table>

        <p
          v-if="collection.size.value > 6"
          class="mt-2 text-xs text-[var(--color-muted-foreground)]"
        >
          Showing 6 of {{ collection.size.value.toLocaleString('en-US') }} — the collection holds
          the rest without paying to render them.
        </p>
      </section>

      <!-- ── 3. markRaw ── -->
      <section class="rounded-xl border border-[var(--color-border)] bg-[var(--color-muted)] p-6">
        <h2 class="text-lg font-semibold text-[var(--color-foreground)]">
          3 · <code>markRaw</code>
        </h2>
        <p class="mt-0.5 text-xs text-[var(--color-muted-foreground)]">
          The collection's lookup index lives on a <code>reactive</code> object next to its revision
          counter. <code>reactive()</code> deep-converts what it holds, so without
          <code>markRaw</code> the index would be a collection proxy: a dependency tracked on every
          <code>get()</code>, effects fired on every <code>set()</code>, for a structure nothing
          renders.
        </p>

        <dl class="mt-4 space-y-2 text-sm">
          <div class="flex items-center justify-between gap-4">
            <dt class="text-[var(--color-muted-foreground)]">
              <code>isReactive(collection.index)</code>
            </dt>
            <dd class="font-mono font-semibold text-[var(--color-foreground)]">
              {{ indexIsReactive }}
            </dd>
          </div>
          <div class="flex items-center justify-between gap-4">
            <dt class="text-[var(--color-muted-foreground)]">
              <code>isReactive(reactive({ index: new Map() }).index)</code>
            </dt>
            <dd class="font-mono font-semibold text-[var(--color-foreground)]">
              {{ unmarkedMapIsReactive }}
            </dd>
          </div>
          <div class="flex items-center justify-between gap-4">
            <dt class="text-[var(--color-muted-foreground)]">indexed keys</dt>
            <dd class="font-mono font-semibold text-[var(--color-foreground)] tabular-nums">
              {{ collection.index.size.toLocaleString('en-US') }}
            </dd>
          </div>
        </dl>
      </section>
    </div>
  </div>
</template>
