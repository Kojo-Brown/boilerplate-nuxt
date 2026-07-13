<script setup lang="ts">
/**
 * SPA — Client-Side Rendering (no SSR)
 *
 * definePageMeta({ ssr: false }) disables server-side rendering for this
 * page. Nuxt sends an empty HTML shell; the browser hydrates and renders
 * entirely in JavaScript.
 *
 * Equivalent routeRules declaration (nuxt.config.ts):
 *   '/rendering/spa': { ssr: false }
 *
 * When to use:
 *  - Auth-gated dashboards that don't benefit from SSR
 *  - Pages with heavy browser-only APIs (WebGL, Web Audio, etc.)
 *  - Admin tools where SEO is irrelevant
 */
definePageMeta({
  title: 'SPA — Client-Side Rendering',
  ssr: false,
})

const mounted = ref(false)
const clientTime = ref('')
const randomValues = ref<number[]>([])

onMounted(() => {
  mounted.value = true
  clientTime.value = new Date().toISOString()
  randomValues.value = Array.from({ length: 5 }, () => Math.random())
})
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
          SPA
          <span class="ml-2 text-base font-normal text-[var(--color-muted-foreground)]">
            Client-Side Rendering
          </span>
        </h1>
        <p class="mt-1 text-[var(--color-muted-foreground)]">
          This page is rendered entirely in the browser — no server HTML is generated.
        </p>
      </div>

      <!-- Client info panel -->
      <div
        class="rounded-xl border border-purple-200 bg-purple-50 p-6 dark:border-purple-800 dark:bg-purple-950/30"
      >
        <h2 class="mb-4 text-lg font-semibold text-[var(--color-foreground)]">Client Info</h2>

        <ClientOnly>
          <template #fallback>
            <p class="text-sm text-[var(--color-muted-foreground)] italic">
              Loading in browser…
            </p>
          </template>

          <dl class="space-y-3 text-sm">
            <div class="flex justify-between gap-4">
              <dt class="font-medium text-[var(--color-muted-foreground)]">Mounted at</dt>
              <dd class="font-mono text-[var(--color-foreground)]">{{ clientTime }}</dd>
            </div>
            <div class="flex justify-between gap-4">
              <dt class="font-medium text-[var(--color-muted-foreground)]">User agent</dt>
              <dd class="max-w-xs truncate font-mono text-[var(--color-foreground)] text-xs">
                {{ navigator.userAgent }}
              </dd>
            </div>
            <div class="flex justify-between gap-4">
              <dt class="font-medium text-[var(--color-muted-foreground)]">Rendering mode</dt>
              <dd>
                <span
                  class="rounded-full bg-purple-100 px-2.5 py-0.5 text-xs font-semibold text-purple-700 dark:bg-purple-900 dark:text-purple-300"
                >
                  SPA (client-only)
                </span>
              </dd>
            </div>
            <div>
              <dt class="mb-1 font-medium text-[var(--color-muted-foreground)]">
                Browser random values (Math.random × 5)
              </dt>
              <dd class="flex flex-wrap gap-1">
                <span
                  v-for="(val, i) in randomValues"
                  :key="i"
                  class="rounded bg-purple-100 px-2 py-0.5 font-mono text-xs text-purple-700 dark:bg-purple-900 dark:text-purple-300"
                >
                  {{ val.toFixed(6) }}
                </span>
              </dd>
            </div>
          </dl>
        </ClientOnly>

        <p class="mt-4 text-xs text-[var(--color-muted-foreground)]">
          Values above are generated in the browser — they would be absent in the server-rendered
          HTML source if you viewed page source.
        </p>
      </div>

      <!-- Code example -->
      <div class="rounded-xl border border-[var(--color-border)] bg-[var(--color-muted)] p-5">
        <h2 class="mb-3 font-semibold text-[var(--color-foreground)]">Configuration</h2>
        <pre
          class="overflow-x-auto rounded-md bg-[var(--color-background)] p-4 text-xs leading-relaxed text-[var(--color-foreground)]"
        ><code>// pages/rendering/spa.vue
definePageMeta({
  ssr: false,   // &lt;-- disables server rendering for this page
})

// Equivalent routeRules in nuxt.config.ts:
// routeRules: {
//   '/rendering/spa': { ssr: false }
// }

// Browser-only code must be guarded with onMounted() or &lt;ClientOnly&gt;
onMounted(() =&gt; {
  // safe to use window / navigator / DOM here
})</code></pre>
      </div>

      <!-- Trade-offs -->
      <div class="rounded-xl border border-[var(--color-border)] bg-[var(--color-muted)] p-5">
        <h2 class="mb-3 font-semibold text-[var(--color-foreground)]">Trade-offs</h2>
        <div class="grid gap-4 text-sm sm:grid-cols-2">
          <div>
            <p class="mb-2 font-medium text-green-600 dark:text-green-400">Pros</p>
            <ul class="space-y-1 text-[var(--color-muted-foreground)]">
              <li>› Full access to browser APIs</li>
              <li>› No hydration mismatch risk</li>
              <li>› Smaller server payload</li>
              <li>› Simpler auth-gated pages</li>
            </ul>
          </div>
          <div>
            <p class="mb-2 font-medium text-red-600 dark:text-red-400">Cons</p>
            <ul class="space-y-1 text-[var(--color-muted-foreground)]">
              <li>› No SEO — crawlers see empty HTML</li>
              <li>› Slower perceived load (blank screen)</li>
              <li>› Requires JS to render anything</li>
              <li>› Network waterfalls visible to users</li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
