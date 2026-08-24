<script setup lang="ts">
/**
 * Nitro route rules — live demo and reference.
 *
 * This page (a plain SSR route) fetches the three demo API endpoints so you can
 * watch the caching rules take effect: the SWR endpoint's timestamp freezes for
 * its cache window, the CORS endpoint can be called from any origin, and the
 * prerendered page linked at the bottom is served as a static file.
 *
 * See route-rules.config.ts for the rule table and docs/nitro-route-rules.md for
 * the full explanation and the measured behaviour on each deploy preset.
 */
import type { RouteRuleSample } from '~/server/api/route-rules/swr.get'
import type { CorsSample } from '~/server/api/route-rules/cors.get'

definePageMeta({ layout: false, title: 'Nitro Route Rules' })

const {
  data: swr,
  refresh: refreshSwr,
  status: swrStatus,
} = useAsyncData('route-rules-swr', () => $fetch<RouteRuleSample>('/api/route-rules/swr'))

const { data: isr, refresh: refreshIsr } = useAsyncData('route-rules-isr', () =>
  $fetch<RouteRuleSample>('/api/route-rules/isr'),
)

const { data: cors, refresh: refreshCors } = useAsyncData('route-rules-cors', () =>
  $fetch<CorsSample>('/api/route-rules/cors'),
)

async function refreshAll() {
  await Promise.all([refreshSwr(), refreshIsr(), refreshCors()])
}

interface RuleCard {
  key: string
  title: string
  rule: string
  blurb: string
  border: string
  bg: string
  badge: string
}

const cards: RuleCard[] = [
  {
    key: 'prerender',
    title: 'Prerender',
    rule: '{ prerender: true }',
    blurb: 'Rendered once at build time and served as a static file. Zero server compute.',
    border: 'border-green-200 dark:border-green-800',
    bg: 'bg-green-50 dark:bg-green-950/30',
    badge: 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300',
  },
  {
    key: 'swr',
    title: 'SWR',
    rule: '{ swr: 30 }',
    blurb: 'Cached 30s, served stale-while-revalidate. Works on the Node preset.',
    border: 'border-amber-200 dark:border-amber-800',
    bg: 'bg-amber-50 dark:bg-amber-950/30',
    badge: 'bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300',
  },
  {
    key: 'isr',
    title: 'ISR',
    rule: '{ isr: 60 }',
    blurb: 'Platform ISR on serverless/edge presets; a cacheable route on Node.',
    border: 'border-blue-200 dark:border-blue-800',
    bg: 'bg-blue-50 dark:bg-blue-950/30',
    badge: 'bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300',
  },
  {
    key: 'cors',
    title: 'CORS',
    rule: '{ cors: true }',
    blurb: 'Access-Control-Allow-* emitted so any origin can fetch the JSON.',
    border: 'border-purple-200 dark:border-purple-800',
    bg: 'bg-purple-50 dark:bg-purple-950/30',
    badge: 'bg-purple-100 text-purple-700 dark:bg-purple-900 dark:text-purple-300',
  },
]
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
        <h1 class="text-3xl font-bold text-[var(--color-foreground)]">Nitro Route Rules</h1>
        <p class="mt-1 text-[var(--color-muted-foreground)]">
          Per-route ISR, SWR, prerender, and CORS — configured once in
          <code class="font-mono text-xs">route-rules.config.ts</code>, applied by Nitro to pages
          and API routes alike.
        </p>
      </div>

      <!-- Rule overview cards -->
      <div class="grid gap-4 sm:grid-cols-2">
        <div
          v-for="card in cards"
          :key="card.key"
          class="rounded-xl border p-5"
          :class="[card.border, card.bg]"
        >
          <div class="flex items-center justify-between">
            <h2 class="font-semibold text-[var(--color-foreground)]">{{ card.title }}</h2>
            <span
              class="rounded-full px-2.5 py-0.5 font-mono text-xs font-semibold"
              :class="card.badge"
            >
              {{ card.rule }}
            </span>
          </div>
          <p class="mt-2 text-sm text-[var(--color-muted-foreground)]">{{ card.blurb }}</p>
        </div>
      </div>

      <!-- Live API responses -->
      <div class="rounded-xl border border-[var(--color-border)] bg-[var(--color-muted)] p-5">
        <div class="mb-4 flex items-center justify-between">
          <h2 class="font-semibold text-[var(--color-foreground)]">Live API responses</h2>
          <button
            class="rounded-md bg-[var(--color-primary)] px-3 py-1.5 text-xs font-medium text-[var(--color-primary-foreground)] hover:opacity-90 focus:ring-2 focus:ring-offset-2 focus:outline-none disabled:opacity-50"
            :disabled="swrStatus === 'pending'"
            @click="refreshAll"
          >
            Refresh all
          </button>
        </div>

        <dl class="space-y-3 text-sm">
          <div class="flex justify-between gap-4">
            <dt class="font-medium text-[var(--color-muted-foreground)]">
              /api/route-rules/swr
              <span class="font-mono text-xs">(swr: 30)</span>
            </dt>
            <dd class="font-mono text-[var(--color-foreground)]">{{ swr?.renderedAt ?? '—' }}</dd>
          </div>
          <div class="flex justify-between gap-4">
            <dt class="font-medium text-[var(--color-muted-foreground)]">
              /api/route-rules/isr
              <span class="font-mono text-xs">(isr: 60)</span>
            </dt>
            <dd class="font-mono text-[var(--color-foreground)]">{{ isr?.renderedAt ?? '—' }}</dd>
          </div>
          <div class="flex justify-between gap-4">
            <dt class="font-medium text-[var(--color-muted-foreground)]">
              /api/route-rules/cors
              <span class="font-mono text-xs">(cors: true)</span>
            </dt>
            <dd class="font-mono text-[var(--color-foreground)]">
              {{ cors ? `${cors.frameworks.length} frameworks` : '—' }}
            </dd>
          </div>
        </dl>

        <p class="mt-4 text-xs text-[var(--color-muted-foreground)]">
          After <code class="font-mono">pnpm build</code>, hit the SWR endpoint repeatedly: its
          timestamp only advances once per 30-second window. The CORS endpoint sends
          <code class="font-mono">Access-Control-Allow-Origin: *</code>, so a page on another origin
          can read it without a proxy.
        </p>
      </div>

      <!-- Prerender link -->
      <div class="rounded-xl border border-[var(--color-border)] bg-[var(--color-muted)] p-5">
        <h2 class="mb-2 font-semibold text-[var(--color-foreground)]">Prerendered page</h2>
        <p class="mb-3 text-sm text-[var(--color-muted-foreground)]">
          The <code class="font-mono text-xs">{ prerender: true }</code> rule turns a page into a
          static file at build time.
        </p>
        <NuxtLink
          to="/route-rules/static"
          class="inline-flex items-center rounded-md border border-[var(--color-border)] bg-[var(--color-background)] px-3 py-1.5 text-sm font-medium text-[var(--color-foreground)] hover:bg-[var(--color-muted)]"
        >
          View the prerendered page →
        </NuxtLink>
      </div>
    </div>
  </div>
</template>
