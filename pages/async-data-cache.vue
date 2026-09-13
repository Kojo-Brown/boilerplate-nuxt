<script setup lang="ts">
import type { PaginatedResponse, Post } from '~/types/api'

definePageMeta({ layout: false })

// `/api/posts` is `authenticated` in server/utils/access-policy.ts, so the SSR
// call has to carry the visitor's cookie. See the note in pages/data-patterns.vue.
const requestFetch = useRequestFetch()

// ─── 1. CACHE KEYS ───────────────────────────────────────────────────────────
// The key is built from the parameters that vary the response, so two calls get
// the same key exactly when they would make the same request. Building it by
// hand — `\`posts-${page}-${limit}\`` — is where collisions come from: nothing
// stops a second endpoint from producing the same string, and then two
// components share one data ref.

const page = ref(1)
const limit = ref(5)

const postsKey = computed(() => asyncDataKey('posts', { page: page.value, limit: limit.value }))

// ─── 2. getCachedData ────────────────────────────────────────────────────────
// Nuxt reuses data on hydration and then never again: every later mount, and
// every return to a key already fetched, goes back to the network. A TTL makes
// paging back and forth free for 60 s, while `refresh()` still always fetches.

const {
  data: posts,
  status: postsStatus,
  refresh: refreshPosts,
  cacheStatus,
  cacheKey,
  invalidate,
  cacheSnapshot,
} = useCachedAsyncData(
  postsKey,
  () =>
    requestFetch<PaginatedResponse<Post>>('/api/posts', {
      params: { page: page.value, limit: limit.value },
    }),
  { ttlMs: 60_000, maxEntries: 10, payloadBudgetBytes: 4 * 1024 },
)

/** Re-read on every interaction; the store is deliberately not reactive. */
const entries = ref(cacheSnapshot())

function syncSnapshot() {
  entries.value = cacheSnapshot()
}

watch(postsStatus, syncSnapshot)

async function forceRefresh() {
  await refreshPosts()
  syncSnapshot()
}

function dropEntry() {
  invalidate()
  syncSnapshot()
}

const CACHE_STATUS_LABELS: Record<string, string> = {
  idle: 'nothing resolved yet',
  hit: 'served from the store — no request',
  miss: 'nothing stored — fetched',
  expired: 'stored copy had aged out — fetched',
  bypass: 'explicit refresh — never answered from cache',
  hydration: 'first client render — reused the SSR payload',
}

// ─── 3. PAYLOAD-SIZE DISCIPLINE ──────────────────────────────────────────────
// Everything resolved on the server is serialized into the HTML as well as
// rendered, so the browser downloads it twice. `transform` runs before Nuxt
// stores the value, which is what makes it the fix rather than a formatting
// convenience — the two panels below fetch the same endpoint and report what
// each one costs.

interface PostSummary {
  id: string
  title: string
}

const { payload: fullPayload } = useCachedAsyncData(
  'posts-full',
  () => requestFetch<PaginatedResponse<Post>>('/api/posts', { params: { page: 1, limit: 20 } }),
  { ttlMs: 60_000 },
)

const { payload: leanPayload } = useCachedAsyncData<PaginatedResponse<Post>, PostSummary[]>(
  'posts-lean',
  () => requestFetch<PaginatedResponse<Post>>('/api/posts', { params: { page: 1, limit: 20 } }),
  {
    ttlMs: 60_000,
    transform: (response) => response.data.map(({ id, title }) => ({ id, title })),
  },
)

/** Both panels read `null` until their first resolution has been measured. */
const fullBytes = computed(() => fullPayload.value?.bytes ?? null)
const leanBytes = computed(() => leanPayload.value?.bytes ?? null)

const savings = computed(() => {
  const full = fullBytes.value
  const lean = leanBytes.value
  if (full === null || lean === null || full === 0) return null
  return Math.round((1 - lean / full) * 100)
})
</script>

<template>
  <div class="min-h-screen bg-[var(--color-background)] p-6">
    <div class="mx-auto max-w-3xl space-y-8">
      <header>
        <h1 class="text-2xl font-bold text-[var(--color-foreground)]">
          Cache keys, getCachedData, and payload size
        </h1>
        <p class="mt-1 text-sm text-[var(--color-muted-foreground)]">
          Three halves of one problem: naming a request, deciding when to reuse its answer, and
          keeping the answer small. See
          <code class="text-xs">docs/async-data-caching.md</code>.
        </p>
      </header>

      <!-- ── 1 + 2. KEYS AND CACHING ── -->
      <section class="rounded-xl border border-[var(--color-border)] bg-[var(--color-muted)] p-6">
        <h2 class="text-lg font-semibold text-[var(--color-foreground)]">Paging</h2>
        <p class="mt-1 text-sm text-[var(--color-muted-foreground)]">
          Page forward, then back. The return is a cache hit for 60 seconds — no request.
        </p>

        <div class="mt-4 flex flex-wrap items-center gap-3">
          <button
            class="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-sm text-[var(--color-foreground)] disabled:opacity-40"
            :disabled="page <= 1"
            @click="page -= 1"
          >
            Previous
          </button>
          <span class="text-sm text-[var(--color-foreground)]">Page {{ page }}</span>
          <button
            class="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-sm text-[var(--color-foreground)]"
            @click="page += 1"
          >
            Next
          </button>

          <select
            v-model.number="limit"
            class="rounded-md border border-[var(--color-border)] bg-[var(--color-background)] px-2 py-1.5 text-sm text-[var(--color-foreground)]"
            aria-label="Posts per page"
          >
            <option :value="5">5 per page</option>
            <option :value="10">10 per page</option>
          </select>

          <button
            class="rounded-md bg-[var(--color-primary)] px-3 py-1.5 text-sm text-[var(--color-primary-foreground)]"
            @click="forceRefresh"
          >
            refresh()
          </button>
          <button
            class="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-sm text-[var(--color-foreground)]"
            @click="dropEntry"
          >
            invalidate()
          </button>
        </div>

        <dl class="mt-4 space-y-1 text-sm">
          <div class="flex gap-2">
            <dt class="font-medium text-[var(--color-foreground)]">Key</dt>
            <dd>
              <code class="text-xs text-[var(--color-muted-foreground)]">{{ cacheKey }}</code>
            </dd>
          </div>
          <div class="flex gap-2">
            <dt class="font-medium text-[var(--color-foreground)]">Last resolution</dt>
            <dd class="text-[var(--color-muted-foreground)]">
              <span class="font-mono text-xs">{{ cacheStatus }}</span>
              — {{ CACHE_STATUS_LABELS[cacheStatus] }}
            </dd>
          </div>
        </dl>

        <ul class="mt-4 space-y-1">
          <li
            v-for="post in posts?.data ?? []"
            :key="post.id"
            class="text-sm text-[var(--color-foreground)]"
          >
            {{ post.title }}
          </li>
        </ul>
      </section>

      <!-- ── STORE CONTENTS ── -->
      <section class="rounded-xl border border-[var(--color-border)] bg-[var(--color-muted)] p-6">
        <h2 class="text-lg font-semibold text-[var(--color-foreground)]">What the store holds</h2>
        <p class="mt-1 text-sm text-[var(--color-muted-foreground)]">
          Capped at 10 entries, oldest write dropped first. A custom
          <code class="text-xs">getCachedData</code> turns off Nuxt's own cleanup for these keys, so
          the cap is the only thing bounding it.
        </p>

        <table class="mt-4 w-full text-left text-sm">
          <thead class="text-[var(--color-muted-foreground)]">
            <tr>
              <th class="py-1 font-medium">Key</th>
              <th class="py-1 font-medium">Age</th>
              <th class="py-1 font-medium">Size</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="entry in entries" :key="entry.key" class="text-[var(--color-foreground)]">
              <td class="py-1 font-mono text-xs">{{ entry.key }}</td>
              <td class="py-1">{{ Math.round(entry.ageMs / 1000) }}s</td>
              <td class="py-1">{{ entry.bytes === null ? '—' : formatBytes(entry.bytes) }}</td>
            </tr>
            <tr v-if="entries.length === 0">
              <td colspan="3" class="py-1 text-[var(--color-muted-foreground)]">Empty.</td>
            </tr>
          </tbody>
        </table>
      </section>

      <!-- ── 3. PAYLOAD SIZE ── -->
      <section class="rounded-xl border border-[var(--color-border)] bg-[var(--color-muted)] p-6">
        <h2 class="text-lg font-semibold text-[var(--color-foreground)]">Payload size</h2>
        <p class="mt-1 text-sm text-[var(--color-muted-foreground)]">
          The same 20 posts, fetched twice. The second call narrows the response with
          <code class="text-xs">transform</code> before Nuxt stores it.
        </p>

        <div class="mt-4 grid gap-4 sm:grid-cols-2">
          <div class="rounded-lg border border-[var(--color-border)] p-4">
            <p class="text-sm font-medium text-[var(--color-foreground)]">Whole response</p>
            <p class="mt-1 text-2xl font-semibold text-[var(--color-foreground)]">
              {{ fullBytes === null ? '—' : formatBytes(fullBytes) }}
            </p>
            <p class="mt-1 text-xs text-[var(--color-muted-foreground)]">
              Every field of every post, serialized into the HTML.
            </p>
          </div>

          <div class="rounded-lg border border-[var(--color-border)] p-4">
            <p class="text-sm font-medium text-[var(--color-foreground)]">id and title only</p>
            <p class="mt-1 text-2xl font-semibold text-[var(--color-foreground)]">
              {{ leanBytes === null ? '—' : formatBytes(leanBytes) }}
            </p>
            <p class="mt-1 text-xs text-[var(--color-muted-foreground)]">
              What the list actually renders.
            </p>
          </div>
        </div>

        <p v-if="savings !== null" class="mt-4 text-sm text-[var(--color-foreground)]">
          <span class="font-semibold">{{ savings }}% smaller</span> — paid on first paint, before
          hydration, on the visitor's connection.
        </p>
      </section>
    </div>
  </div>
</template>
