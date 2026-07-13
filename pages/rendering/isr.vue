<script setup lang="ts">
/**
 * ISR — Incremental Static Regeneration (stale-while-revalidate)
 *
 * This page is configured via routeRules in nuxt.config.ts:
 *   '/rendering/isr': { swr: 60 }
 *
 * Nuxt caches the rendered HTML for 60 seconds. Subsequent requests
 * within that window receive the cached version instantly. After the TTL,
 * the next request triggers background regeneration (stale-while-revalidate).
 *
 * definePageMeta cannot express swr — use routeRules for ISR.
 *
 * When to use:
 *  - News feeds, product listings, leaderboards
 *  - Content that updates every few minutes/hours, not per-request
 *  - High-traffic pages where avoiding per-request SSR saves server cost
 */
definePageMeta({ title: 'ISR — Incremental Static Regeneration' })

const { data: serverInfo } = await useAsyncData('isr-demo', () =>
  $fetch<{ timestamp: string; random: number; mode: string }>('/api/rendering/info'),
)
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
          ISR
          <span class="ml-2 text-base font-normal text-[var(--color-muted-foreground)]">
            Incremental Static Regeneration
          </span>
        </h1>
        <p class="mt-1 text-[var(--color-muted-foreground)]">
          Cached SSR with background regeneration — configured via
          <code class="font-mono text-xs">routeRules: &#123; swr: 60 &#125;</code>.
        </p>
      </div>

      <!-- Server response panel -->
      <div
        class="rounded-xl border border-amber-200 bg-amber-50 p-6 dark:border-amber-800 dark:bg-amber-950/30"
      >
        <h2 class="mb-4 text-lg font-semibold text-[var(--color-foreground)]">
          Cached Server Response
        </h2>

        <dl class="space-y-3 text-sm">
          <div class="flex justify-between gap-4">
            <dt class="font-medium text-[var(--color-muted-foreground)]">
              Rendered / cached at
            </dt>
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
                class="rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-semibold text-amber-700 dark:bg-amber-900 dark:text-amber-300"
              >
                ISR (swr: 60 s)
              </span>
            </dd>
          </div>
        </dl>

        <p class="mt-4 text-xs text-[var(--color-muted-foreground)]">
          The timestamp and random value stay frozen for 60 seconds. After the TTL the next
          visitor triggers a background re-render while still receiving the stale cache.
        </p>
      </div>

      <!-- How swr works -->
      <div class="rounded-xl border border-[var(--color-border)] bg-[var(--color-muted)] p-5">
        <h2 class="mb-3 font-semibold text-[var(--color-foreground)]">
          How stale-while-revalidate works
        </h2>
        <ol class="space-y-2 text-sm text-[var(--color-muted-foreground)]">
          <li class="flex gap-3">
            <span class="mt-0.5 h-5 w-5 shrink-0 rounded-full bg-amber-100 text-center text-xs font-bold text-amber-700 dark:bg-amber-900 dark:text-amber-300 leading-5">1</span>
            <span>First request: Nuxt renders the page on the server and stores the HTML in the cache.</span>
          </li>
          <li class="flex gap-3">
            <span class="mt-0.5 h-5 w-5 shrink-0 rounded-full bg-amber-100 text-center text-xs font-bold text-amber-700 dark:bg-amber-900 dark:text-amber-300 leading-5">2</span>
            <span>Requests within the TTL (60 s): Nuxt returns the cached HTML immediately — zero server cost.</span>
          </li>
          <li class="flex gap-3">
            <span class="mt-0.5 h-5 w-5 shrink-0 rounded-full bg-amber-100 text-center text-xs font-bold text-amber-700 dark:bg-amber-900 dark:text-amber-300 leading-5">3</span>
            <span>After TTL: the next request gets the stale cache; Nuxt re-renders in the background and updates the cache.</span>
          </li>
          <li class="flex gap-3">
            <span class="mt-0.5 h-5 w-5 shrink-0 rounded-full bg-amber-100 text-center text-xs font-bold text-amber-700 dark:bg-amber-900 dark:text-amber-300 leading-5">4</span>
            <span>Subsequent requests: receive the freshly regenerated HTML.</span>
          </li>
        </ol>
      </div>

      <!-- Code example -->
      <div class="rounded-xl border border-[var(--color-border)] bg-[var(--color-muted)] p-5">
        <h2 class="mb-3 font-semibold text-[var(--color-foreground)]">Configuration</h2>
        <pre
          class="overflow-x-auto rounded-md bg-[var(--color-background)] p-4 text-xs leading-relaxed text-[var(--color-foreground)]"
        ><code>// nuxt.config.ts — ISR is configured via routeRules, not definePageMeta
export default defineNuxtConfig({
  routeRules: {
    '/rendering/isr': { swr: 60 },          // 60-second SWR cache
    '/rendering/isr-long': { swr: 3600 },   // 1-hour SWR cache

    // Other caching strategies:
    // { cache: { maxAge: 60 } }            // HTTP cache headers only
    // { prerender: true }                  // full SSG
    // { ssr: false }                       // SPA mode
  },
})</code></pre>
      </div>
    </div>
  </div>
</template>
