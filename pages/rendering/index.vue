<script setup lang="ts">
definePageMeta({ title: 'Rendering Modes' })

const modes = [
  {
    label: 'SSR',
    href: '/rendering/ssr',
    badge: 'Server-Side Rendering',
    description:
      'Default Nuxt mode. The page is rendered on the server for every request, delivering fresh HTML to the client.',
    bullets: [
      'Rendered on every request',
      'Always fresh data',
      'SEO-friendly out of the box',
      'Configured via nuxt.config routeRules (default)',
    ],
    color: 'text-blue-600 dark:text-blue-400',
    border: 'border-blue-200 dark:border-blue-800',
    bg: 'bg-blue-50 dark:bg-blue-950/30',
    badgeBg: 'bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300',
  },
  {
    label: 'SSG',
    href: '/rendering/ssg',
    badge: 'Static Site Generation',
    description:
      'Page is pre-rendered at build time. The resulting HTML is served as a static file — fastest possible TTFB.',
    bullets: [
      'Built once, served infinitely',
      'Zero server compute per request',
      'definePageMeta({ prerender: true })',
      'Also configurable via routeRules',
    ],
    color: 'text-green-600 dark:text-green-400',
    border: 'border-green-200 dark:border-green-800',
    bg: 'bg-green-50 dark:bg-green-950/30',
    badgeBg: 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300',
  },
  {
    label: 'SPA',
    href: '/rendering/spa',
    badge: 'Client-Side Rendering',
    description:
      'No server rendering; the browser downloads a shell and renders the page entirely in JavaScript.',
    bullets: [
      'Hydrated in the browser only',
      'Ideal for auth-gated dashboards',
      'definePageMeta({ ssr: false })',
      'routeRules: { ssr: false }',
    ],
    color: 'text-purple-600 dark:text-purple-400',
    border: 'border-purple-200 dark:border-purple-800',
    bg: 'bg-purple-50 dark:bg-purple-950/30',
    badgeBg: 'bg-purple-100 text-purple-700 dark:bg-purple-900 dark:text-purple-300',
  },
  {
    label: 'ISR',
    href: '/rendering/isr',
    badge: 'Incremental Static Regeneration',
    description:
      'Hybrid mode: serve a cached static response and regenerate it in the background after a TTL expires (stale-while-revalidate).',
    bullets: [
      'routeRules: { swr: 60 } (60 s TTL)',
      'Combines SSG speed + SSR freshness',
      'Ideal for semi-dynamic content',
      'Configured globally in nuxt.config',
    ],
    color: 'text-amber-600 dark:text-amber-400',
    border: 'border-amber-200 dark:border-amber-800',
    bg: 'bg-amber-50 dark:bg-amber-950/30',
    badgeBg: 'bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300',
  },
] as const
</script>

<template>
  <div class="min-h-screen bg-[var(--color-background)] p-8">
    <div class="mx-auto max-w-4xl space-y-8">
      <div>
        <h1 class="text-3xl font-bold text-[var(--color-foreground)]">Rendering Modes</h1>
        <p class="mt-2 text-[var(--color-muted-foreground)]">
          Nuxt 4 supports per-page rendering strategies via
          <code class="rounded bg-[var(--color-muted)] px-1 py-0.5 text-xs font-mono">definePageMeta</code>
          and
          <code class="rounded bg-[var(--color-muted)] px-1 py-0.5 text-xs font-mono">routeRules</code>
          in
          <code class="rounded bg-[var(--color-muted)] px-1 py-0.5 text-xs font-mono">nuxt.config.ts</code>.
        </p>
      </div>

      <div class="grid gap-4 sm:grid-cols-2">
        <NuxtLink
          v-for="mode in modes"
          :key="mode.label"
          :to="mode.href"
          :class="[
            'group block rounded-xl border p-5 transition-shadow hover:shadow-md',
            mode.border,
            mode.bg,
          ]"
        >
          <div class="flex items-start justify-between gap-3">
            <span :class="['text-2xl font-bold', mode.color]">{{ mode.label }}</span>
            <span
              :class="[
                'shrink-0 rounded-full px-2.5 py-0.5 text-xs font-semibold',
                mode.badgeBg,
              ]"
            >
              {{ mode.badge }}
            </span>
          </div>

          <p class="mt-2 text-sm text-[var(--color-muted-foreground)]">{{ mode.description }}</p>

          <ul class="mt-3 space-y-1">
            <li
              v-for="bullet in mode.bullets"
              :key="bullet"
              class="flex items-center gap-2 text-xs text-[var(--color-muted-foreground)]"
            >
              <span :class="['shrink-0 font-bold', mode.color]">›</span>
              <code class="font-mono">{{ bullet }}</code>
            </li>
          </ul>
        </NuxtLink>
      </div>

      <div
        class="rounded-xl border border-[var(--color-border)] bg-[var(--color-muted)] p-5 text-sm"
      >
        <h2 class="mb-2 font-semibold text-[var(--color-foreground)]">
          routeRules vs definePageMeta
        </h2>
        <p class="text-[var(--color-muted-foreground)]">
          Both configure the same rendering behaviour.
          <strong class="text-[var(--color-foreground)]">routeRules</strong> (in
          <code class="font-mono text-xs">nuxt.config.ts</code>) applies globally and supports
          server-side cache policies like
          <code class="font-mono text-xs">swr</code>.
          <strong class="text-[var(--color-foreground)]">definePageMeta</strong> keeps the config
          co-located with the page component and is the preferred choice for
          <code class="font-mono text-xs">prerender</code> and
          <code class="font-mono text-xs">ssr: false</code>.
        </p>
      </div>
    </div>
  </div>
</template>
