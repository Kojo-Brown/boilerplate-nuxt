<script setup lang="ts">
/**
 * Streaming SSR responses — live demo.
 *
 * The feed below is an NDJSON stream read with `useNdjsonStream`, so the records
 * render as they arrive rather than when the response ends. The three controls
 * exist because each one shows something the transport has to get right:
 *
 *  - **Stream** — records appear one at a time. `$fetch` against the same URL
 *    would show all of them at once, `count × delay` milliseconds later.
 *  - **Stop** — aborts mid-stream. The records already received stay; the dev
 *    server logs how far the generator got before its `finally` ran.
 *  - **Fail at record 4** — the source throws after the response has started.
 *    The status is still 200, and the failure arrives as an `error` frame.
 *
 * `/api/streaming/shell` is the other half of the item, and cannot be shown in
 * this page: it is a progressively rendered HTML *document*, so it has to be
 * opened as one.
 */
import { computed, ref } from 'vue'

import type { FeedItem } from '~/server/api/streaming/feed.get'

definePageMeta({ layout: false, title: 'Streaming SSR' })

const RECORD_COUNT = 8
const RECORD_DELAY_MS = 300

const failAt = ref<number | null>(null)

const feedUrl = computed(() => {
  const query = new URLSearchParams({
    count: String(RECORD_COUNT),
    delay: String(RECORD_DELAY_MS),
  })
  if (failAt.value !== null) query.set('failAt', String(failAt.value))
  return `/api/streaming/feed?${query.toString()}`
})

// The URL is a getter, so changing `failAt` is enough — the composable reads it
// when `start()` runs rather than binding to whatever it was on setup.
const { items, status, error, expected, start, stop } = useNdjsonStream<FeedItem>(feedUrl)

const streaming = computed(() => status.value === 'streaming')

async function stream(failAtRecord: number | null) {
  failAt.value = failAtRecord
  await start()
}
</script>

<template>
  <div class="min-h-screen bg-[var(--color-background)] p-8">
    <div class="mx-auto max-w-2xl space-y-6">
      <NuxtLink
        to="/"
        class="text-sm text-[var(--color-muted-foreground)] hover:text-[var(--color-foreground)]"
      >
        ← Home
      </NuxtLink>

      <div>
        <h1 class="text-3xl font-bold text-[var(--color-foreground)]">Streaming SSR responses</h1>
        <p class="mt-1 text-[var(--color-muted-foreground)]">
          <code class="font-mono text-xs">sendStream</code> writes a response as it is produced
          instead of after. The records below are read off
          <code class="font-mono text-xs">/api/streaming/feed</code> one line at a time — the first
          one is on screen before the last one has been generated.
        </p>
      </div>

      <!-- Controls -->
      <div class="rounded-xl border border-[var(--color-border)] bg-[var(--color-muted)] p-5">
        <div class="flex flex-wrap items-center gap-2">
          <button
            class="rounded-md bg-[var(--color-primary)] px-3 py-1.5 text-sm font-medium text-[var(--color-primary-foreground)] hover:opacity-90 focus:ring-2 focus:ring-offset-2 focus:outline-none disabled:opacity-50"
            :disabled="streaming"
            @click="stream(null)"
          >
            Stream {{ RECORD_COUNT }} records
          </button>
          <button
            class="rounded-md border border-[var(--color-border)] bg-[var(--color-background)] px-3 py-1.5 text-sm font-medium text-[var(--color-foreground)] hover:bg-[var(--color-muted)] disabled:opacity-50"
            :disabled="!streaming"
            @click="stop"
          >
            Stop
          </button>
          <button
            class="rounded-md border border-[var(--color-border)] bg-[var(--color-background)] px-3 py-1.5 text-sm font-medium text-[var(--color-foreground)] hover:bg-[var(--color-muted)] disabled:opacity-50"
            :disabled="streaming"
            @click="stream(4)"
          >
            Fail at record 4
          </button>
        </div>

        <dl class="mt-4 flex flex-wrap gap-x-6 gap-y-1 text-sm">
          <div class="flex gap-2">
            <dt class="text-[var(--color-muted-foreground)]">status</dt>
            <dd class="font-mono text-[var(--color-foreground)]">{{ status }}</dd>
          </div>
          <div class="flex gap-2">
            <dt class="text-[var(--color-muted-foreground)]">received</dt>
            <dd class="font-mono text-[var(--color-foreground)]">
              {{ items.length }}<span v-if="expected !== null"> / {{ expected }}</span>
            </dd>
          </div>
        </dl>

        <p v-if="error" class="mt-3 text-sm text-red-600 dark:text-red-400">{{ error }}</p>
      </div>

      <!-- Records -->
      <div class="rounded-xl border border-[var(--color-border)] bg-[var(--color-muted)] p-5">
        <h2 class="mb-3 font-semibold text-[var(--color-foreground)]">Records</h2>

        <ol v-if="items.length > 0" class="space-y-2">
          <li
            v-for="item in items"
            :key="item.id"
            class="flex justify-between gap-4 rounded-md bg-[var(--color-background)] px-3 py-2 text-sm"
          >
            <span class="text-[var(--color-foreground)]">{{ item.label }}</span>
            <span class="font-mono text-xs text-[var(--color-muted-foreground)]">
              +{{ item.elapsedMs }} ms
            </span>
          </li>
        </ol>

        <p v-else class="text-sm text-[var(--color-muted-foreground)]">
          Nothing yet. Start a stream above.
        </p>
      </div>

      <!-- Progressive HTML -->
      <div class="rounded-xl border border-[var(--color-border)] bg-[var(--color-muted)] p-5">
        <h2 class="mb-2 font-semibold text-[var(--color-foreground)]">Progressive HTML</h2>
        <p class="mb-3 text-sm text-[var(--color-muted-foreground)]">
          The same transport carrying a document instead of data.
          <code class="font-mono text-xs">/api/streaming/shell</code> flushes its shell immediately
          and then one section at a time, with no JavaScript on either side. Open it in a tab and
          watch the sections land.
        </p>
        <a
          href="/api/streaming/shell"
          target="_blank"
          rel="noopener"
          class="inline-block rounded-md border border-[var(--color-border)] bg-[var(--color-background)] px-3 py-1.5 text-sm font-medium text-[var(--color-foreground)] hover:bg-[var(--color-muted)]"
        >
          Open the streamed document ↗
        </a>
      </div>

      <p class="text-xs text-[var(--color-muted-foreground)]">
        Both routes sit under the default-deny half of
        <code class="font-mono">server/utils/access-policy.ts</code>, so they need a session — a
        stream is rendered per request and shared with nobody, which is the case the public
        carve-outs for the cached routes were making the opposite argument about. See
        <code class="font-mono">docs/nitro-streaming.md</code>.
      </p>
    </div>
  </div>
</template>
