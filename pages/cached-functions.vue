<script setup lang="ts">
/**
 * Cached server functions and tag invalidation — live demo.
 *
 * The two reads below are `defineCachedEventHandler` routes wrapped by
 * `defineCachedApiHandler` (`server/utils/cached-route.ts`). Refresh them and
 * `renderedAt` does not move: that is the cache. Invalidate a tag and the next
 * refresh re-renders, without waiting out `maxAge` — which is the part Nitro has
 * no answer for on its own.
 *
 * `useAsyncData` caches per key on the client too, so every read here goes
 * through `refresh()`; a plain re-render would show this page's own payload
 * rather than the server's. See docs/nitro-cached-functions.md.
 */
import type { CatalogPage } from '~/server/api/cached/catalog.get'
import type { CatalogItemResponse } from '~/server/api/cached/catalog/[id].get'
import type { InvalidationSummary } from '~/server/api/cached/invalidate.post'
import type { ApiResponse } from '~/types/api'

definePageMeta({ layout: false, title: 'Cached Server Functions' })

const { data: list, refresh: refreshList } = useAsyncData('cached-catalog', () =>
  $fetch<CatalogPage>('/api/cached/catalog', { query: { page: 1 } }),
)

const { data: item, refresh: refreshItem } = useAsyncData('cached-catalog-item', () =>
  $fetch<CatalogItemResponse>('/api/cached/catalog/4'),
)

const lastInvalidation = ref<InvalidationSummary | null>(null)
const invalidating = ref(false)
const error = ref<string | null>(null)

async function refreshAll() {
  await Promise.all([refreshList(), refreshItem()])
}

async function invalidate(tags: string[]) {
  invalidating.value = true
  error.value = null

  try {
    const response = await $fetch<ApiResponse<InvalidationSummary>>('/api/cached/invalidate', {
      method: 'POST',
      body: { tags },
    })
    lastInvalidation.value = response.data
    await refreshAll()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : 'Invalidation failed'
  } finally {
    invalidating.value = false
  }
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
        <h1 class="text-3xl font-bold text-[var(--color-foreground)]">Cached server functions</h1>
        <p class="mt-1 text-[var(--color-muted-foreground)]">
          <code class="font-mono text-xs">defineCachedEventHandler</code> caches a response for
          <code class="font-mono text-xs">maxAge</code> seconds and has no way to end that early.
          These routes attach <strong>tags</strong> to what they render, so a change in the data can
          drop exactly the entries it affects.
        </p>
      </div>

      <!-- Cached reads -->
      <div class="rounded-xl border border-[var(--color-border)] bg-[var(--color-muted)] p-5">
        <div class="mb-4 flex items-center justify-between">
          <h2 class="font-semibold text-[var(--color-foreground)]">Cached reads</h2>
          <button
            class="rounded-md bg-[var(--color-primary)] px-3 py-1.5 text-xs font-medium text-[var(--color-primary-foreground)] hover:opacity-90 focus:ring-2 focus:ring-offset-2 focus:outline-none disabled:opacity-50"
            :disabled="invalidating"
            @click="refreshAll"
          >
            Refresh both
          </button>
        </div>

        <dl class="space-y-3 text-sm">
          <div class="flex justify-between gap-4">
            <dt class="font-medium text-[var(--color-muted-foreground)]">
              /api/cached/catalog?page=1
              <span class="font-mono text-xs">(maxAge: 30, tags: catalog)</span>
            </dt>
            <dd class="font-mono text-[var(--color-foreground)]">{{ list?.renderedAt ?? '—' }}</dd>
          </div>
          <div class="flex justify-between gap-4">
            <dt class="font-medium text-[var(--color-muted-foreground)]">
              /api/cached/catalog/4
              <span class="font-mono text-xs">(maxAge: 60, tags: catalog, catalog:4)</span>
            </dt>
            <dd class="font-mono text-[var(--color-foreground)]">{{ item?.renderedAt ?? '—' }}</dd>
          </div>
        </dl>

        <p class="mt-4 text-xs text-[var(--color-muted-foreground)]">
          Refreshing does not move either timestamp — both responses come from Nitro's storage. The
          list has rendered {{ list?.renders ?? 0 }} time(s) since this server started.
        </p>
      </div>

      <!-- Invalidation -->
      <div class="rounded-xl border border-[var(--color-border)] bg-[var(--color-muted)] p-5">
        <h2 class="mb-2 font-semibold text-[var(--color-foreground)]">Invalidate a tag</h2>
        <p class="mb-4 text-sm text-[var(--color-muted-foreground)]">
          The narrow tag drops one item and leaves the list cached. The broad one drops both,
          because both routes carry it.
        </p>

        <div class="flex flex-wrap gap-2">
          <button
            class="rounded-md border border-[var(--color-border)] bg-[var(--color-background)] px-3 py-1.5 text-sm font-medium text-[var(--color-foreground)] hover:bg-[var(--color-muted)] disabled:opacity-50"
            :disabled="invalidating"
            @click="invalidate(['catalog:4'])"
          >
            Invalidate <code class="font-mono text-xs">catalog:4</code>
          </button>
          <button
            class="rounded-md border border-[var(--color-border)] bg-[var(--color-background)] px-3 py-1.5 text-sm font-medium text-[var(--color-foreground)] hover:bg-[var(--color-muted)] disabled:opacity-50"
            :disabled="invalidating"
            @click="invalidate(['catalog'])"
          >
            Invalidate <code class="font-mono text-xs">catalog</code>
          </button>
        </div>

        <p v-if="error" class="mt-4 text-sm text-red-600 dark:text-red-400">{{ error }}</p>

        <div v-else-if="lastInvalidation" class="mt-4 text-sm">
          <p class="text-[var(--color-foreground)]">
            Removed {{ lastInvalidation.removed }} entr{{
              lastInvalidation.removed === 1 ? 'y' : 'ies'
            }}
            for {{ lastInvalidation.tags.join(', ') }}:
          </p>
          <ul class="mt-2 space-y-1">
            <li
              v-for="entry in lastInvalidation.entries"
              :key="entry"
              class="font-mono text-xs break-all text-[var(--color-muted-foreground)]"
            >
              {{ entry }}
            </li>
            <li
              v-if="lastInvalidation.entries.length === 0"
              class="text-xs text-[var(--color-muted-foreground)]"
            >
              Nothing was cached under those tags — they had already expired or been swept.
            </li>
          </ul>
        </div>
      </div>

      <p class="text-xs text-[var(--color-muted-foreground)]">
        In dev, Nitro's <code class="font-mono">cache</code> base is a directory under
        <code class="font-mono">.nuxt/</code>, so the entries and their tag index are visible on
        disk. In production set <code class="font-mono">NUXT_REDIS_URL</code> so every instance
        shares one cache and one invalidation — see
        <code class="font-mono">docs/nitro-storage.md</code>.
      </p>
    </div>
  </div>
</template>
