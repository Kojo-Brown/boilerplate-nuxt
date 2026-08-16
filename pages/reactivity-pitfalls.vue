<script setup lang="ts">
import {
  computed,
  reactive,
  ref,
  shallowRef,
  toRef,
  toRefs,
  triggerRef,
  watchSyncEffect,
} from 'vue'
import type { Ref } from 'vue'

definePageMeta({ layout: false })

// Every number on this page comes from the running app, not from a caption.
// Where a claim is about *notification* rather than about a value, it is
// measured with a `watchSyncEffect` counter rather than read off the DOM: a
// re-render triggered by some unrelated click would otherwise refresh a stale
// display and make a broken case look like it works.
//
// The `formatReactivity` labels are all computed here rather than in the
// template, and that is not incidental — a top-level ref is auto-unwrapped in
// a template, so `formatReactivity(bound)` there would classify the *number*
// and report every ref on the page as `plain (not tracked)`. Same class of
// mistake the page is about.

/** Counts re-runs of an effect that reads `read()`. */
function countRuns(read: () => unknown): Ref<number> {
  const runs = ref(0)
  watchSyncEffect(() => {
    read()
    runs.value += 1
  })
  return runs
}

// ─── 1. Destructuring loss ───────────────────────────────────────────────────
// `copied` is bound once, during setup, and is a plain number from then on. No
// amount of re-rendering moves it, because there is nothing left to re-read.

const counter = reactive({ count: 0 })
const { count: copied } = counter
const { count: bound } = toRefs(counter)

const copiedKind = formatReactivity(copied)
const boundKind = formatReactivity(bound)

const copiedRuns = countRuns(() => copied)
const boundRuns = countRuns(() => bound.value)

function increment(): void {
  counter.count += 1
}

function resetCounter(): void {
  counter.count = 0
}

// ─── 2. toRefs snapshots the key set ─────────────────────────────────────────
// `toRefs` walks the keys once. `toRef` binds the key itself, so it survives
// the property not existing yet.

interface Filters {
  query: string
  page?: number
}

const filters = reactive<Filters>({ query: '' })
const snapshot = toRefs(filters)
const pageByToRef = toRef(filters, 'page')

// Consts, not computeds: the snapshot is a plain object built once at setup,
// so there is nothing here for a computed to react to. That is the point.
const snapshotKeys = Object.keys(snapshot).join(', ')
const snapshotHasPage = 'page' in snapshot
const pageByToRefKind = formatReactivity(pageByToRef)

function addPageKey(): void {
  filters.page = (filters.page ?? 0) + 1
}

function dropPageKey(): void {
  delete filters.page
}

// ─── 3. Deep vs shallow ──────────────────────────────────────────────────────
// The shallow source is the interesting one: mutating through `.value` is
// invisible, and a `computed` over it does not go late — it goes *wrong*, and
// stays wrong until something publishes.

interface Row {
  id: number
  score: number
}

const deepRows = ref<Row[]>([{ id: 1, score: 1 }])
const shallowRows = shallowRef<Row[]>([{ id: 1, score: 1 }])

const deepRowsKind = formatReactivity(deepRows)
const shallowRowsKind = formatReactivity(shallowRows)

const deepRuns = countRuns(() => deepRows.value[0]?.score)
const shallowRuns = countRuns(() => shallowRows.value[0]?.score)

const deepTotal = computed(() => deepRows.value.reduce((sum, row) => sum + row.score, 0))
const shallowTotal = computed(() => shallowRows.value.reduce((sum, row) => sum + row.score, 0))

/**
 * Deliberately a function rather than a `computed`. A computed over the
 * shallow source would cache the same wrong answer as `shallowTotal` and this
 * row would have nothing to reveal; called from the template, it re-reads the
 * array on whatever render the deep source happens to trigger, which is how
 * you can see that the data really did change and only the notification was
 * lost.
 */
function actualShallowScores(): string {
  return shallowRows.value.map((row) => row.score).join(', ')
}

function bumpBoth(): void {
  // The identical mutation on both sources. Only the deep one notifies.
  deepRows.value[0]!.score += 1
  shallowRows.value[0]!.score += 1
}

function publishShallow(): void {
  triggerRef(shallowRows)
}

function replaceShallow(): void {
  shallowRows.value = shallowRows.value.map((row) => ({ ...row }))
}

function resetRows(): void {
  deepRows.value = [{ id: 1, score: 1 }]
  shallowRows.value = [{ id: 1, score: 1 }]
}
</script>

<template>
  <div class="min-h-screen bg-[var(--color-background)] p-6">
    <div class="mx-auto max-w-3xl space-y-8">
      <header>
        <h1 class="text-2xl font-bold text-[var(--color-foreground)]">Reactivity Pitfalls</h1>
        <p class="mt-1 text-sm text-[var(--color-muted-foreground)]">
          Nothing throws when a reactive binding is severed — the view just stops updating, far from
          the line that caused it. Each panel runs the broken version and the fixed version side by
          side against the same mutation. The write-up is in
          <code>docs/reactivity-pitfalls.md</code>, and every claim it makes is asserted in
          <code>tests/unit/reactivity-pitfalls.test.ts</code>.
        </p>
      </header>

      <!-- ── 1. Destructuring loss ── -->
      <section class="rounded-xl border border-[var(--color-border)] bg-[var(--color-muted)] p-6">
        <h2 class="text-lg font-semibold text-[var(--color-foreground)]">
          Destructuring severs the binding
        </h2>
        <p class="mt-0.5 text-xs text-[var(--color-muted-foreground)]">
          <code>const { count } = state</code> runs the proxy's getter once and keeps the number.
          <code>toRefs</code> hands back a two-way view instead.
        </p>

        <div class="mt-4 grid gap-3 sm:grid-cols-2">
          <div class="rounded-lg border border-red-500/40 bg-[var(--color-background)] p-4">
            <p class="text-xs font-semibold tracking-wide text-red-500 uppercase">Broken</p>
            <code class="mt-1 block text-xs text-[var(--color-muted-foreground)]">
              const { count } = state
            </code>
            <p class="mt-3 text-3xl font-bold text-[var(--color-foreground)]">{{ copied }}</p>
            <dl class="mt-2 space-y-0.5 text-xs text-[var(--color-muted-foreground)]">
              <div class="flex justify-between gap-2">
                <dt>describeReactivity</dt>
                <dd class="font-mono">{{ copiedKind }}</dd>
              </div>
              <div class="flex justify-between gap-2">
                <dt>effect re-runs</dt>
                <dd class="font-mono">{{ copiedRuns }}</dd>
              </div>
            </dl>
          </div>

          <div class="rounded-lg border border-green-500/40 bg-[var(--color-background)] p-4">
            <p class="text-xs font-semibold tracking-wide text-green-600 uppercase">Fixed</p>
            <code class="mt-1 block text-xs text-[var(--color-muted-foreground)]">
              const { count } = toRefs(state)
            </code>
            <p class="mt-3 text-3xl font-bold text-[var(--color-foreground)]">{{ bound }}</p>
            <dl class="mt-2 space-y-0.5 text-xs text-[var(--color-muted-foreground)]">
              <div class="flex justify-between gap-2">
                <dt>describeReactivity</dt>
                <dd class="font-mono">{{ boundKind }}</dd>
              </div>
              <div class="flex justify-between gap-2">
                <dt>effect re-runs</dt>
                <dd class="font-mono">{{ boundRuns }}</dd>
              </div>
            </dl>
          </div>
        </div>

        <p class="mt-3 text-xs text-[var(--color-muted-foreground)]">
          Source of truth: <code class="font-mono">state.count === {{ counter.count }}</code>
        </p>

        <div class="mt-3 flex gap-2">
          <button
            class="rounded-md bg-[var(--color-primary)] px-3 py-1.5 text-sm font-medium text-white hover:opacity-90 focus:ring-2 focus:ring-[var(--color-primary)] focus:outline-none"
            @click="increment"
          >
            state.count++
          </button>
          <button
            class="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-sm text-[var(--color-foreground)] hover:bg-[var(--color-muted)] focus:ring-2 focus:ring-[var(--color-primary)] focus:outline-none"
            @click="resetCounter"
          >
            Reset
          </button>
        </div>
      </section>

      <!-- ── 2. toRefs vs toRef ── -->
      <section class="rounded-xl border border-[var(--color-border)] bg-[var(--color-muted)] p-6">
        <h2 class="text-lg font-semibold text-[var(--color-foreground)]">
          <code>toRefs</code> snapshots the keys, <code>toRef</code> binds one
        </h2>
        <p class="mt-0.5 text-xs text-[var(--color-muted-foreground)]">
          Add the optional <code>page</code> key after <code>toRefs</code> has already run. The
          snapshot never grows a ref for it. <code>toRef(filters, 'page')</code> was bound to the
          key rather than to its value, so it tracks the property appearing and disappearing.
        </p>

        <div class="mt-4 grid gap-3 sm:grid-cols-2">
          <div class="rounded-lg border border-red-500/40 bg-[var(--color-background)] p-4">
            <p class="text-xs font-semibold tracking-wide text-red-500 uppercase">
              toRefs(filters)
            </p>
            <dl class="mt-3 space-y-0.5 text-xs text-[var(--color-muted-foreground)]">
              <div class="flex justify-between gap-2">
                <dt>keys captured</dt>
                <dd class="font-mono">{{ snapshotKeys }}</dd>
              </div>
              <div class="flex justify-between gap-2">
                <dt>has a `page` ref</dt>
                <dd class="font-mono">{{ snapshotHasPage }}</dd>
              </div>
            </dl>
          </div>

          <div class="rounded-lg border border-green-500/40 bg-[var(--color-background)] p-4">
            <p class="text-xs font-semibold tracking-wide text-green-600 uppercase">
              toRef(filters, 'page')
            </p>
            <dl class="mt-3 space-y-0.5 text-xs text-[var(--color-muted-foreground)]">
              <div class="flex justify-between gap-2">
                <dt>value</dt>
                <dd class="font-mono">{{ pageByToRef ?? 'undefined' }}</dd>
              </div>
              <div class="flex justify-between gap-2">
                <dt>describeReactivity</dt>
                <dd class="font-mono">{{ pageByToRefKind }}</dd>
              </div>
            </dl>
          </div>
        </div>

        <p class="mt-3 text-xs text-[var(--color-muted-foreground)]">
          Source of truth: <code class="font-mono">{{ JSON.stringify(filters) }}</code>
        </p>

        <div class="mt-3 flex gap-2">
          <button
            class="rounded-md bg-[var(--color-primary)] px-3 py-1.5 text-sm font-medium text-white hover:opacity-90 focus:ring-2 focus:ring-[var(--color-primary)] focus:outline-none"
            @click="addPageKey"
          >
            filters.page++
          </button>
          <button
            class="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-sm text-[var(--color-foreground)] hover:bg-[var(--color-muted)] focus:ring-2 focus:ring-[var(--color-primary)] focus:outline-none"
            @click="dropPageKey"
          >
            delete filters.page
          </button>
        </div>
      </section>

      <!-- ── 3. Deep vs shallow ── -->
      <section class="rounded-xl border border-[var(--color-border)] bg-[var(--color-muted)] p-6">
        <h2 class="text-lg font-semibold text-[var(--color-foreground)]">
          Shallow makes correctness your job
        </h2>
        <p class="mt-0.5 text-xs text-[var(--color-muted-foreground)]">
          One button mutates <code>rows[0].score</code> on both sources. The deep ref notifies; the
          shallow one does not, and its <code>computed</code> is left holding a cached answer that
          is now simply wrong — not late. <code>triggerRef</code>, or replacing <code>.value</code>,
          is the only thing that fixes it.
        </p>

        <div class="mt-4 grid gap-3 sm:grid-cols-2">
          <div
            class="rounded-lg border border-[var(--color-border)] bg-[var(--color-background)] p-4"
          >
            <p class="text-xs font-semibold tracking-wide text-[var(--color-foreground)] uppercase">
              ref — deep
            </p>
            <p class="mt-3 text-3xl font-bold text-[var(--color-foreground)]">{{ deepTotal }}</p>
            <dl class="mt-2 space-y-0.5 text-xs text-[var(--color-muted-foreground)]">
              <div class="flex justify-between gap-2">
                <dt>describeReactivity</dt>
                <dd class="font-mono">{{ deepRowsKind }}</dd>
              </div>
              <div class="flex justify-between gap-2">
                <dt>effect re-runs</dt>
                <dd class="font-mono">{{ deepRuns }}</dd>
              </div>
            </dl>
          </div>

          <div
            class="rounded-lg border border-[var(--color-border)] bg-[var(--color-background)] p-4"
          >
            <p class="text-xs font-semibold tracking-wide text-[var(--color-foreground)] uppercase">
              shallowRef
            </p>
            <p class="mt-3 text-3xl font-bold text-[var(--color-foreground)]">{{ shallowTotal }}</p>
            <dl class="mt-2 space-y-0.5 text-xs text-[var(--color-muted-foreground)]">
              <div class="flex justify-between gap-2">
                <dt>describeReactivity</dt>
                <dd class="font-mono">{{ shallowRowsKind }}</dd>
              </div>
              <div class="flex justify-between gap-2">
                <dt>effect re-runs</dt>
                <dd class="font-mono">{{ shallowRuns }}</dd>
              </div>
              <div class="flex justify-between gap-2">
                <dt>scores actually in the array</dt>
                <dd class="font-mono">{{ actualShallowScores() }}</dd>
              </div>
            </dl>
          </div>
        </div>

        <div class="mt-3 flex flex-wrap gap-2">
          <button
            class="rounded-md bg-[var(--color-primary)] px-3 py-1.5 text-sm font-medium text-white hover:opacity-90 focus:ring-2 focus:ring-[var(--color-primary)] focus:outline-none"
            @click="bumpBoth"
          >
            rows[0].score++ on both
          </button>
          <button
            class="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-sm text-[var(--color-foreground)] hover:bg-[var(--color-muted)] focus:ring-2 focus:ring-[var(--color-primary)] focus:outline-none"
            @click="publishShallow"
          >
            triggerRef(shallowRows)
          </button>
          <button
            class="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-sm text-[var(--color-foreground)] hover:bg-[var(--color-muted)] focus:ring-2 focus:ring-[var(--color-primary)] focus:outline-none"
            @click="replaceShallow"
          >
            replace .value
          </button>
          <button
            class="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-sm text-[var(--color-foreground)] hover:bg-[var(--color-muted)] focus:ring-2 focus:ring-[var(--color-primary)] focus:outline-none"
            @click="resetRows"
          >
            Reset
          </button>
        </div>
      </section>
    </div>
  </div>
</template>
