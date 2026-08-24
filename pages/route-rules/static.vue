<script setup lang="ts">
/**
 * Prerendered page — emitted as static HTML at build time.
 *
 * The `prerender: true` route rule for `/route-rules/static` (see
 * route-rules.config.ts) tells Nitro to render this page once during
 * `nuxt build` and write it to `.output/public/route-rules/static/index.html`.
 * At request time a CDN or static file server returns that file with zero
 * server compute.
 *
 * The page is intentionally free of any per-request or per-user data — that is
 * the contract of a prerendered route. `buildStamp` is evaluated when the page
 * is rendered, which during a real build is build time; in `nuxt dev` it
 * reflects the current render because there is no build step.
 */
definePageMeta({ layout: false, title: 'Prerendered — Nitro Route Rules' })

const buildStamp = new Date().toISOString()
</script>

<template>
  <div class="min-h-screen bg-[var(--color-background)] p-8">
    <div class="mx-auto max-w-2xl space-y-6">
      <NuxtLink
        to="/route-rules"
        class="text-sm text-[var(--color-muted-foreground)] hover:text-[var(--color-foreground)]"
      >
        ← Route Rules
      </NuxtLink>

      <div>
        <h1 class="text-3xl font-bold text-[var(--color-foreground)]">
          Prerendered
          <span class="ml-2 text-base font-normal text-[var(--color-muted-foreground)]">
            static HTML at build time
          </span>
        </h1>
        <p class="mt-1 text-[var(--color-muted-foreground)]">
          Served from <code class="font-mono text-xs">.output/public/route-rules/static/</code> with
          no server compute per request.
        </p>
      </div>

      <div
        class="rounded-xl border border-green-200 bg-green-50 p-6 dark:border-green-800 dark:bg-green-950/30"
      >
        <dl class="space-y-3 text-sm">
          <div class="flex justify-between gap-4">
            <dt class="font-medium text-[var(--color-muted-foreground)]">Rendered at</dt>
            <dd class="font-mono text-[var(--color-foreground)]">{{ buildStamp }}</dd>
          </div>
          <div class="flex justify-between gap-4">
            <dt class="font-medium text-[var(--color-muted-foreground)]">Route rule</dt>
            <dd>
              <span
                class="rounded-full bg-green-100 px-2.5 py-0.5 text-xs font-semibold text-green-700 dark:bg-green-900 dark:text-green-300"
              >
                prerender: true
              </span>
            </dd>
          </div>
        </dl>
        <p class="mt-4 text-xs text-[var(--color-muted-foreground)]">
          After <code class="font-mono">pnpm build</code> this timestamp is frozen at build time —
          reload as often as you like, it never changes.
        </p>
      </div>

      <div class="rounded-xl border border-[var(--color-border)] bg-[var(--color-muted)] p-5">
        <h2 class="mb-3 font-semibold text-[var(--color-foreground)]">Configuration</h2>
        <pre
          class="overflow-x-auto rounded-md bg-[var(--color-background)] p-4 text-xs leading-relaxed text-[var(--color-foreground)]"
        ><code>// route-rules.config.ts
export const routeRules = {
  '/route-rules/static': { prerender: true },
}</code></pre>
      </div>
    </div>
  </div>
</template>
