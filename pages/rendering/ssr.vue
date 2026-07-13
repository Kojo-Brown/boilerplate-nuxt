<script setup lang="ts">
/**
 * SSR — Server-Side Rendering (default)
 *
 * Nuxt renders this page on the server for every incoming request.
 * No special definePageMeta flag is needed; SSR is the default mode.
 *
 * Equivalent routeRules declaration (nuxt.config.ts):
 *   '/rendering/ssr': {}   // empty = SSR default
 *
 * When to use:
 *  - Pages with per-user data
 *  - Pages where freshness matters more than cache hit-rate
 *  - Any page that cannot be pre-rendered at build time
 */
definePageMeta({ title: 'SSR — Server-Side Rendering' })

const { data: serverInfo, refresh } = await useAsyncData('ssr-demo', () =>
  $fetch<{ timestamp: string; random: number; mode: string }>('/api/rendering/info'),
)

const refreshing = ref(false)
async function handleRefresh() {
  refreshing.value = true
  await refresh()
  refreshing.value = false
}
</script>

<template>
  <div class="min-h-screen bg-[var(--color-background)] p-8">
    <div class="mx-auto max-w-2xl space-y-6">
      <div class="flex items-center gap-3">
        <NuxtLink
          to="/rendering"
          class="text-sm text-[var(--color-muted-foreground)] hover:text-[var(--color-foreground)]"
        >
          ← Rendering Modes
        </NuxtLink>
      </div>

      <div>
        <h1 class="text-3xl font-bold text-[var(--color-foreground)]">
          SSR
          <span class="ml-2 text-base font-normal text-[var(--color-muted-foreground)]">
            Server-Side Rendering
          </span>
        </h1>
        <p class="mt-1 text-[var(--color-muted-foreground)]">
          This page is rendered on the server for every request.
        </p>
      </div>

      <!-- Live data panel -->
      <div
        class="rounded-xl border border-blue-200 bg-blue-50 p-6 dark:border-blue-800 dark:bg-blue-950/30"
      >
        <h2 class="mb-4 text-lg font-semibold text-[var(--color-foreground)]">
          Server Response
        </h2>

        <dl class="space-y-3 text-sm">
          <div class="flex justify-between gap-4">
            <dt class="font-medium text-[var(--color-muted-foreground)]">Rendered at</dt>
            <dd class="font-mono text-[var(--color-foreground)]">
              {{ serverInfo?.timestamp ?? '—' }}
            </dd>
          </div>
          <div class="flex justify-between gap-4">
            <dt class="font-medium text-[var(--color-muted-foreground)]">Random value</dt>
            <dd class="font-mono text-[var(--color-foreground)]">
              {{ serverInfo?.random ?? '—' }}
            </dd>
          </div>
          <div class="flex justify-between gap-4">
            <dt class="font-medium text-[var(--color-muted-foreground)]">Rendering mode</dt>
            <dd>
              <span
                class="rounded-full bg-blue-100 px-2.5 py-0.5 text-xs font-semibold text-blue-700 dark:bg-blue-900 dark:text-blue-300"
              >
                {{ serverInfo?.mode ?? 'SSR' }}
              </span>
            </dd>
          </div>
        </dl>

        <p class="mt-4 text-xs text-[var(--color-muted-foreground)]">
          Every page load generates a new timestamp and random value — proof that the server runs
          fresh logic per request.
        </p>

        <button
          class="mt-4 rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          :disabled="refreshing"
          @click="handleRefresh"
        >
          {{ refreshing ? 'Refreshing…' : 'Refresh (re-fetch)' }}
        </button>
      </div>

      <!-- Code example -->
      <div class="rounded-xl border border-[var(--color-border)] bg-[var(--color-muted)] p-5">
        <h2 class="mb-3 font-semibold text-[var(--color-foreground)]">Configuration</h2>
        <pre
          class="overflow-x-auto rounded-md bg-[var(--color-background)] p-4 text-xs leading-relaxed text-[var(--color-foreground)]"
        ><code>// pages/rendering/ssr.vue
// No special definePageMeta needed — SSR is the default.

// Equivalent routeRules in nuxt.config.ts:
// routeRules: {
//   '/rendering/ssr': {}  // empty object = SSR
// }

const { data } = await useAsyncData('key', () =&gt;
  $fetch('/api/rendering/info')
)</code></pre>
      </div>
    </div>
  </div>
</template>
