<script setup lang="ts">
/**
 * SSG — Static Site Generation
 *
 * definePageMeta({ prerender: true }) tells the Nuxt build to run this
 * page through the crawler at build time and emit a static HTML file.
 *
 * Equivalent routeRules declaration (nuxt.config.ts):
 *   '/rendering/ssg': { prerender: true }
 *
 * When to use:
 *  - Marketing pages, docs, blogs
 *  - Any content that doesn't change per-user or per-request
 *  - Pages where TTFB (time-to-first-byte) is the top priority
 */
definePageMeta({
  title: 'SSG — Static Site Generation',
  prerender: true,
})

const buildInfo = {
  builtAt: new Date().toISOString(),
  note:
    'In a real build this timestamp would be frozen at build time. ' +
    'During development it reflects the server start time.',
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
          SSG
          <span class="ml-2 text-base font-normal text-[var(--color-muted-foreground)]">
            Static Site Generation
          </span>
        </h1>
        <p class="mt-1 text-[var(--color-muted-foreground)]">
          This page is pre-rendered once at build time and served as static HTML.
        </p>
      </div>

      <!-- Build info panel -->
      <div
        class="rounded-xl border border-green-200 bg-green-50 p-6 dark:border-green-800 dark:bg-green-950/30"
      >
        <h2 class="mb-4 text-lg font-semibold text-[var(--color-foreground)]">Build Info</h2>

        <dl class="space-y-3 text-sm">
          <div class="flex justify-between gap-4">
            <dt class="font-medium text-[var(--color-muted-foreground)]">Built at</dt>
            <dd class="font-mono text-[var(--color-foreground)]">{{ buildInfo.builtAt }}</dd>
          </div>
          <div class="flex justify-between gap-4">
            <dt class="font-medium text-[var(--color-muted-foreground)]">Rendering mode</dt>
            <dd>
              <span
                class="rounded-full bg-green-100 px-2.5 py-0.5 text-xs font-semibold text-green-700 dark:bg-green-900 dark:text-green-300"
              >
                SSG (prerendered)
              </span>
            </dd>
          </div>
        </dl>

        <p class="mt-4 text-xs text-[var(--color-muted-foreground)]">
          {{ buildInfo.note }}
        </p>

        <div
          class="mt-4 rounded-md border border-green-300 bg-green-100 px-4 py-2 text-xs font-medium text-green-800 dark:border-green-700 dark:bg-green-900/40 dark:text-green-300"
        >
          No server compute on page load — the CDN returns a pre-built file instantly.
        </div>
      </div>

      <!-- Code example -->
      <div class="rounded-xl border border-[var(--color-border)] bg-[var(--color-muted)] p-5">
        <h2 class="mb-3 font-semibold text-[var(--color-foreground)]">Configuration</h2>
        <pre
          class="overflow-x-auto rounded-md bg-[var(--color-background)] p-4 text-xs leading-relaxed text-[var(--color-foreground)]"
        ><code>// pages/rendering/ssg.vue
definePageMeta({
  prerender: true,   // &lt;-- pre-renders this route at build time
})

// Equivalent routeRules in nuxt.config.ts:
// routeRules: {
//   '/rendering/ssg': { prerender: true }
// }

// Run `pnpm generate` to see the static output in .output/public/</code></pre>
      </div>

      <!-- Trade-offs -->
      <div class="rounded-xl border border-[var(--color-border)] bg-[var(--color-muted)] p-5">
        <h2 class="mb-3 font-semibold text-[var(--color-foreground)]">Trade-offs</h2>
        <div class="grid gap-4 text-sm sm:grid-cols-2">
          <div>
            <p class="mb-2 font-medium text-green-600 dark:text-green-400">Pros</p>
            <ul class="space-y-1 text-[var(--color-muted-foreground)]">
              <li>› Zero server compute per request</li>
              <li>› Instant CDN delivery</li>
              <li>› Lowest possible TTFB</li>
              <li>› Works without a Node.js server</li>
            </ul>
          </div>
          <div>
            <p class="mb-2 font-medium text-red-600 dark:text-red-400">Cons</p>
            <ul class="space-y-1 text-[var(--color-muted-foreground)]">
              <li>› Content frozen at build time</li>
              <li>› Requires full rebuild to update</li>
              <li>› Not suitable for user-specific data</li>
              <li>› Build time grows with page count</li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
