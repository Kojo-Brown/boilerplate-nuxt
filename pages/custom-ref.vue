<script setup lang="ts">
import { computed, ref, watch } from 'vue'

definePageMeta({ layout: false })

// ─── 1. Debounced search ─────────────────────────────────────────────────────
// The ref is bound straight to the input. Nothing downstream knows it is
// debounced: the `watch` below is an ordinary watcher that happens to fire once
// per pause instead of once per keystroke.

const SEARCH_DELAY = 400
const SEARCH_MAX_WAIT = 1_500

const query = useDebouncedRef('', SEARCH_DELAY, { maxWait: SEARCH_MAX_WAIT })
// Destructured because a top-level ref is auto-unwrapped in the template:
// `query.flush` there would read a property of the *string*, not of the ref.
const { draft: typed, pending: searchPending, flush: flushQuery, cancel: cancelQuery } = query

const searchSignature = `useDebouncedRef('', ${SEARCH_DELAY}, { maxWait: ${SEARCH_MAX_WAIT} })`

const keystrokes = ref(0)
const searches = ref(0)
const lastSearched = ref('')

watch(typed, () => {
  keystrokes.value += 1
})

watch(query, (value) => {
  searches.value += 1
  lastSearched.value = value
})

const saved = computed(() => Math.max(0, keystrokes.value - searches.value))

function resetSearch(): void {
  query.cancel()
  query.value = ''
  query.flush()
  keystrokes.value = 0
  searches.value = 0
  lastSearched.value = ''
}

// ─── 2. Throttled pointer ────────────────────────────────────────────────────
// The opposite trade. Debouncing a pointer shows nothing until the hand stops;
// throttling publishes the intermediate positions at a rate the app can afford,
// and the trailing commit guarantees the resting position is never lost.

interface Point {
  x: number
  y: number
}

const POINTER_INTERVAL = 120

const pointer = useThrottledRef<Point>({ x: 50, y: 50 }, POINTER_INTERVAL)
const { pending: pointerPending } = pointer

const pointerSignature = `useThrottledRef({ x: 50, y: 50 }, ${POINTER_INTERVAL})`
const pointerRate = Math.round(1_000 / POINTER_INTERVAL)

const samples = ref(0)
const publishes = ref(0)

watch(pointer, () => {
  publishes.value += 1
})

function trackPointer(event: PointerEvent): void {
  const bounds = (event.currentTarget as HTMLElement).getBoundingClientRect()
  samples.value += 1
  pointer.value = {
    x: clampPercent(((event.clientX - bounds.left) / bounds.width) * 100),
    y: clampPercent(((event.clientY - bounds.top) / bounds.height) * 100),
  }
}

function clampPercent(value: number): number {
  return Math.round(Math.min(100, Math.max(0, value)))
}

function resetPointer(): void {
  pointer.cancel()
  samples.value = 0
  publishes.value = 0
}
</script>

<template>
  <div class="min-h-screen bg-[var(--color-background)] p-6">
    <div class="mx-auto max-w-3xl space-y-8">
      <header>
        <h1 class="text-2xl font-bold text-[var(--color-foreground)]">Deferred Refs</h1>
        <p class="mt-1 text-sm text-[var(--color-muted-foreground)]">
          <code>customRef</code> hands you <code>track</code> and <code>trigger</code>, so a ref can
          separate <em>when a value is written</em> from <em>when its readers are told</em>. The
          delay lives in the value, not in the handler — every consumer inherits it, including ones
          written later that know nothing about it.
        </p>
      </header>

      <!-- ── 1. Debounce ── -->
      <section class="rounded-xl border border-[var(--color-border)] bg-[var(--color-muted)] p-6">
        <h2 class="text-lg font-semibold text-[var(--color-foreground)]">
          Debounced — commit after the writes stop
        </h2>
        <p class="mt-0.5 text-xs text-[var(--color-muted-foreground)]">
          <code>{{ searchSignature }}</code> — type quickly and the search count barely moves. Keep
          typing without pausing and <code>maxWait</code> commits anyway, so the search cannot be
          starved forever.
        </p>

        <label class="mt-4 block">
          <span class="text-xs font-medium text-[var(--color-foreground)]">Search</span>
          <input
            v-model="query"
            type="text"
            placeholder="Start typing…"
            class="mt-1 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-background)] px-3 py-2 text-sm text-[var(--color-foreground)] focus:ring-2 focus:ring-[var(--color-primary)] focus:outline-none"
            @keydown.enter="flushQuery()"
          />
        </label>

        <p class="mt-2 text-xs text-[var(--color-muted-foreground)]">
          The input never stutters while a write is deferred: the DOM element owns the text, and Vue
          only patches it when the ref changes — which is when the debounce commits the same text
          back. Press <kbd>Enter</kbd> to <code>flush()</code> instead of waiting.
        </p>

        <div class="mt-4 grid gap-3 sm:grid-cols-4">
          <div
            class="rounded-lg border border-[var(--color-border)] bg-[var(--color-background)] p-3"
          >
            <p class="text-xs text-[var(--color-muted-foreground)]">Keystrokes</p>
            <p class="mt-1 font-mono text-xl font-bold text-[var(--color-foreground)]">
              {{ keystrokes }}
            </p>
          </div>
          <div
            class="rounded-lg border border-[var(--color-border)] bg-[var(--color-background)] p-3"
          >
            <p class="text-xs text-[var(--color-muted-foreground)]">Searches</p>
            <p class="mt-1 font-mono text-xl font-bold text-[var(--color-primary)]">
              {{ searches }}
            </p>
          </div>
          <div
            class="rounded-lg border border-[var(--color-border)] bg-[var(--color-background)] p-3"
          >
            <p class="text-xs text-[var(--color-muted-foreground)]">Requests avoided</p>
            <p class="mt-1 font-mono text-xl font-bold text-[var(--color-foreground)]">
              {{ saved }}
            </p>
          </div>
          <div
            class="rounded-lg border border-[var(--color-border)] bg-[var(--color-background)] p-3"
          >
            <p class="text-xs text-[var(--color-muted-foreground)]">State</p>
            <p
              class="mt-1 font-mono text-xl font-bold"
              :class="
                searchPending
                  ? 'text-[var(--color-primary)]'
                  : 'text-[var(--color-muted-foreground)]'
              "
            >
              {{ searchPending ? 'pending' : 'settled' }}
            </p>
          </div>
        </div>

        <dl class="mt-4 space-y-1 font-mono text-xs text-[var(--color-muted-foreground)]">
          <div class="flex gap-2">
            <dt class="w-28 shrink-0">draft</dt>
            <dd class="truncate text-[var(--color-foreground)]">{{ typed || '—' }}</dd>
          </div>
          <div class="flex gap-2">
            <dt class="w-28 shrink-0">query.value</dt>
            <dd class="truncate text-[var(--color-foreground)]">{{ query || '—' }}</dd>
          </div>
          <div class="flex gap-2">
            <dt class="w-28 shrink-0">last search</dt>
            <dd class="truncate text-[var(--color-foreground)]">{{ lastSearched || '—' }}</dd>
          </div>
        </dl>

        <div class="mt-4 flex flex-wrap gap-2">
          <button
            class="rounded-md bg-[var(--color-primary)] px-3 py-1.5 text-xs font-medium text-[var(--color-primary-foreground)] hover:opacity-90"
            @click="flushQuery()"
          >
            flush()
          </button>
          <button
            class="rounded-md border border-[var(--color-border)] bg-[var(--color-background)] px-3 py-1.5 text-xs font-medium text-[var(--color-foreground)] hover:bg-[var(--color-muted)]"
            @click="cancelQuery()"
          >
            cancel()
          </button>
          <button
            class="rounded-md border border-[var(--color-border)] bg-[var(--color-background)] px-3 py-1.5 text-xs font-medium text-[var(--color-foreground)] hover:bg-[var(--color-muted)]"
            @click="resetSearch()"
          >
            Reset counters
          </button>
        </div>
      </section>

      <!-- ── 2. Throttle ── -->
      <section class="rounded-xl border border-[var(--color-border)] bg-[var(--color-muted)] p-6">
        <h2 class="text-lg font-semibold text-[var(--color-foreground)]">
          Throttled — commit at most once per interval
        </h2>
        <p class="mt-0.5 text-xs text-[var(--color-muted-foreground)]">
          <code>{{ pointerSignature }}</code> — move the pointer across the pad. The marker keeps
          up, at roughly {{ pointerRate }} updates a second instead of one per pointer event.
          Debouncing here would show nothing at all until the hand stopped.
        </p>

        <div
          class="relative mt-4 h-56 cursor-crosshair overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-background)]"
          @pointermove="trackPointer"
        >
          <div
            class="absolute h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[var(--color-primary)] transition-all duration-100 ease-linear"
            :style="{ left: `${pointer.x}%`, top: `${pointer.y}%` }"
          />
          <p
            class="pointer-events-none absolute inset-x-0 bottom-2 text-center text-xs text-[var(--color-muted-foreground)]"
          >
            {{ samples === 0 ? 'Move the pointer here' : `x ${pointer.x}% · y ${pointer.y}%` }}
          </p>
        </div>

        <div class="mt-4 grid gap-3 sm:grid-cols-3">
          <div
            class="rounded-lg border border-[var(--color-border)] bg-[var(--color-background)] p-3"
          >
            <p class="text-xs text-[var(--color-muted-foreground)]">Pointer events</p>
            <p class="mt-1 font-mono text-xl font-bold text-[var(--color-foreground)]">
              {{ samples }}
            </p>
          </div>
          <div
            class="rounded-lg border border-[var(--color-border)] bg-[var(--color-background)] p-3"
          >
            <p class="text-xs text-[var(--color-muted-foreground)]">Published</p>
            <p class="mt-1 font-mono text-xl font-bold text-[var(--color-primary)]">
              {{ publishes }}
            </p>
          </div>
          <div
            class="rounded-lg border border-[var(--color-border)] bg-[var(--color-background)] p-3"
          >
            <p class="text-xs text-[var(--color-muted-foreground)]">State</p>
            <p
              class="mt-1 font-mono text-xl font-bold"
              :class="
                pointerPending
                  ? 'text-[var(--color-primary)]'
                  : 'text-[var(--color-muted-foreground)]'
              "
            >
              {{ pointerPending ? 'pending' : 'settled' }}
            </p>
          </div>
        </div>

        <button
          class="mt-4 rounded-md border border-[var(--color-border)] bg-[var(--color-background)] px-3 py-1.5 text-xs font-medium text-[var(--color-foreground)] hover:bg-[var(--color-muted)]"
          @click="resetPointer()"
        >
          Reset counters
        </button>
      </section>
    </div>
  </div>
</template>
