<script setup lang="ts">
import type { ServerMetrics } from '~/server/api/metrics.get'
import type { PaginatedResponse } from '~/types/api'

definePageMeta({ layout: false })

// ─── 1. POLLING ──────────────────────────────────────────────────────────────
// usePollingData wraps useAsyncData and auto-refreshes on a set interval.
// The loop pauses when the browser tab is hidden and resumes immediately
// (with a fresh fetch) when the tab becomes active again.

const {
  data: metrics,
  status: metricsStatus,
  refresh: refreshMetrics,
  isPolling,
  startPolling,
  stopPolling,
} = usePollingData<ServerMetrics>('server-metrics', () => $fetch('/api/metrics'), {
  interval: 5_000,
  pauseOnHidden: true,
})

// ─── 2. REFRESH — reactive key ────────────────────────────────────────────────
// When the computed key changes (because `page` changed), useAsyncData fires a
// fresh request automatically. No manual watcher needed.

const page = ref(1)
const limit = ref(5)

const {
  data: postsPage,
  status: postsStatus,
  refresh: refreshPosts,
} = useAsyncData<PaginatedResponse<{ id: string; title: string; body: string; authorId: string; createdAt: string; updatedAt: string }>>(
  // Key includes reactive state → changes to `page` trigger a new fetch
  () => `posts-page-${page.value}-limit-${limit.value}`,
  () => $fetch('/api/posts', { params: { page: page.value, limit: limit.value } }),
)

// ─── 3. DEDUPE ───────────────────────────────────────────────────────────────
// Multiple useAsyncData calls with the same static key share one data ref.
// dedupe: 'defer' means: if a refresh is already in flight, skip the new
// request and let the existing one resolve instead of cancelling it.
// This prevents redundant network traffic when many components refresh at once.

const {
  data: sharedPost,
  status: sharedStatus,
  refresh: refreshShared,
} = useAsyncData(
  'shared-post-1',                          // same key used in both panels below
  () => $fetch('/api/posts/post-1'),
  { dedupe: 'defer' },                      // defer: re-use the in-flight request
)

// Simulate a second consumer with the identical key — returns the same ref
const { data: sharedPostConsumer2 } = useAsyncData(
  'shared-post-1',
  () => $fetch('/api/posts/post-1'),
  { dedupe: 'defer' },
)

const dedupeLog = ref<string[]>([])

async function triggerDedupe() {
  dedupeLog.value = []
  dedupeLog.value.push('Both consumers called refresh() simultaneously…')

  const t0 = Date.now()
  await Promise.all([refreshShared(), refreshShared()])
  const elapsed = Date.now() - t0

  dedupeLog.value.push(
    `Resolved in ${elapsed} ms — only one network request was made (dedupe: 'defer').`,
  )
}
</script>

<template>
  <div class="min-h-screen bg-[var(--color-background)] p-6">
    <div class="mx-auto max-w-3xl space-y-8">
      <header>
        <h1 class="text-2xl font-bold text-[var(--color-foreground)]">useAsyncData Patterns</h1>
        <p class="mt-1 text-sm text-[var(--color-muted-foreground)]">
          Three patterns: polling, reactive-key refresh, and request deduplication.
        </p>
      </header>

      <!-- ── 1. POLLING ── -->
      <section class="rounded-xl border border-[var(--color-border)] bg-[var(--color-muted)] p-6">
        <div class="flex items-center justify-between mb-4">
          <div>
            <h2 class="text-lg font-semibold text-[var(--color-foreground)]">1 · Polling</h2>
            <p class="text-xs text-[var(--color-muted-foreground)] mt-0.5">
              Auto-refreshes every 5 s; pauses when the tab is hidden.
            </p>
          </div>

          <div class="flex items-center gap-2">
            <span
              class="inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium"
              :class="isPolling ? 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200' : 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300'"
            >
              <span
                class="h-1.5 w-1.5 rounded-full"
                :class="isPolling ? 'bg-green-500 animate-pulse' : 'bg-gray-400'"
              />
              {{ isPolling ? 'Polling' : 'Paused' }}
            </span>

            <button
              class="rounded-md border border-[var(--color-border)] bg-[var(--color-background)] px-3 py-1 text-xs font-medium text-[var(--color-foreground)] hover:bg-[var(--color-muted)]"
              @click="isPolling ? stopPolling() : startPolling()"
            >
              {{ isPolling ? 'Pause' : 'Resume' }}
            </button>

            <button
              class="rounded-md bg-[var(--color-primary)] px-3 py-1 text-xs font-medium text-[var(--color-primary-foreground)] hover:opacity-90"
              :disabled="metricsStatus === 'pending'"
              @click="refreshMetrics()"
            >
              Refresh now
            </button>
          </div>
        </div>

        <div v-if="metricsStatus === 'pending' && !metrics" class="text-sm text-[var(--color-muted-foreground)]">
          Loading…
        </div>

        <div v-else-if="metrics" class="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div
            v-for="[label, value] in [
              ['Requests', metrics.requestCount],
              ['Uptime', `${metrics.uptimeSeconds}s`],
              ['Memory', `${metrics.memoryMb} MB`],
              ['Fetched at', new Date(metrics.timestamp).toLocaleTimeString()],
            ]"
            :key="String(label)"
            class="rounded-lg bg-[var(--color-background)] p-3 border border-[var(--color-border)]"
          >
            <p class="text-xs text-[var(--color-muted-foreground)]">{{ label }}</p>
            <p class="mt-1 text-lg font-semibold text-[var(--color-foreground)]">{{ value }}</p>
          </div>
        </div>
      </section>

      <!-- ── 2. REFRESH (reactive key) ── -->
      <section class="rounded-xl border border-[var(--color-border)] bg-[var(--color-muted)] p-6">
        <div class="flex items-start justify-between mb-4">
          <div>
            <h2 class="text-lg font-semibold text-[var(--color-foreground)]">2 · Refresh</h2>
            <p class="text-xs text-[var(--color-muted-foreground)] mt-0.5">
              Reactive key: changing the page triggers a new fetch automatically.
              Manual button calls <code class="font-mono">refresh()</code>.
            </p>
          </div>

          <button
            class="rounded-md bg-[var(--color-primary)] px-3 py-1 text-xs font-medium text-[var(--color-primary-foreground)] hover:opacity-90 disabled:opacity-50"
            :disabled="postsStatus === 'pending'"
            @click="refreshPosts()"
          >
            {{ postsStatus === 'pending' ? 'Loading…' : 'Refresh' }}
          </button>
        </div>

        <!-- Pagination controls -->
        <div class="flex items-center gap-3 mb-4">
          <label class="text-xs text-[var(--color-muted-foreground)]">Page size</label>
          <select
            class="rounded border border-[var(--color-border)] bg-[var(--color-background)] px-2 py-1 text-xs text-[var(--color-foreground)]"
            :value="limit"
            @change="limit = Number(($event.target as HTMLSelectElement).value); page = 1"
          >
            <option value="3">3</option>
            <option value="5">5</option>
            <option value="10">10</option>
          </select>

          <div class="ml-auto flex items-center gap-1">
            <button
              class="rounded border border-[var(--color-border)] bg-[var(--color-background)] px-2 py-1 text-xs text-[var(--color-foreground)] disabled:opacity-40"
              :disabled="page <= 1"
              @click="page--"
            >
              ‹ Prev
            </button>
            <span class="px-2 text-xs text-[var(--color-muted-foreground)]">Page {{ page }}</span>
            <button
              class="rounded border border-[var(--color-border)] bg-[var(--color-background)] px-2 py-1 text-xs text-[var(--color-foreground)] disabled:opacity-40"
              :disabled="!postsPage?.pagination.hasMore"
              @click="page++"
            >
              Next ›
            </button>
          </div>
        </div>

        <div v-if="postsStatus === 'pending'" class="text-sm text-[var(--color-muted-foreground)]">
          Loading posts…
        </div>

        <ul v-else-if="postsPage" class="divide-y divide-[var(--color-border)]">
          <li
            v-for="post in postsPage.data"
            :key="post.id"
            class="py-2 text-sm"
          >
            <span class="font-medium text-[var(--color-foreground)]">{{ post.title }}</span>
            <span class="ml-2 text-xs text-[var(--color-muted-foreground)]">{{ post.id }}</span>
          </li>
        </ul>

        <p class="mt-2 text-xs text-[var(--color-muted-foreground)]">
          Active key: <code class="font-mono">posts-page-{{ page }}-limit-{{ limit }}</code>
        </p>
      </section>

      <!-- ── 3. DEDUPE ── -->
      <section class="rounded-xl border border-[var(--color-border)] bg-[var(--color-muted)] p-6">
        <div class="mb-4">
          <h2 class="text-lg font-semibold text-[var(--color-foreground)]">3 · Dedupe</h2>
          <p class="text-xs text-[var(--color-muted-foreground)] mt-0.5">
            Two components share the key <code class="font-mono">shared-post-1</code>.
            <code class="font-mono">dedupe: 'defer'</code> means a second refresh that
            arrives while the first is in-flight is dropped — only one request is made.
          </p>
        </div>

        <div class="grid grid-cols-2 gap-4 mb-4">
          <!-- Consumer A -->
          <div class="rounded-lg border border-[var(--color-border)] bg-[var(--color-background)] p-3">
            <p class="text-xs font-semibold text-[var(--color-muted-foreground)] mb-2">Consumer A</p>
            <div v-if="sharedStatus === 'pending'" class="text-xs text-[var(--color-muted-foreground)]">Loading…</div>
            <div v-else-if="sharedPost">
              <p class="text-sm font-medium text-[var(--color-foreground)]">{{ (sharedPost as { data: { title: string } }).data.title }}</p>
              <p class="text-xs text-[var(--color-muted-foreground)]">{{ (sharedPost as { data: { id: string } }).data.id }}</p>
            </div>
          </div>

          <!-- Consumer B — same key, same data ref, zero extra requests -->
          <div class="rounded-lg border border-[var(--color-border)] bg-[var(--color-background)] p-3">
            <p class="text-xs font-semibold text-[var(--color-muted-foreground)] mb-2">Consumer B (same key)</p>
            <div v-if="!sharedPostConsumer2" class="text-xs text-[var(--color-muted-foreground)]">Loading…</div>
            <div v-else>
              <p class="text-sm font-medium text-[var(--color-foreground)]">{{ (sharedPostConsumer2 as { data: { title: string } }).data.title }}</p>
              <p class="text-xs text-[var(--color-muted-foreground)]">{{ (sharedPostConsumer2 as { data: { id: string } }).data.id }}</p>
            </div>
          </div>
        </div>

        <button
          class="rounded-md bg-[var(--color-primary)] px-3 py-1 text-xs font-medium text-[var(--color-primary-foreground)] hover:opacity-90"
          @click="triggerDedupe()"
        >
          Trigger simultaneous refresh ×2
        </button>

        <ul v-if="dedupeLog.length" class="mt-3 space-y-1">
          <li
            v-for="(entry, i) in dedupeLog"
            :key="i"
            class="text-xs text-[var(--color-muted-foreground)] font-mono"
          >
            {{ entry }}
          </li>
        </ul>
      </section>
    </div>
  </div>
</template>
