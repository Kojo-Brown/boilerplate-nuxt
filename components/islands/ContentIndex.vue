<script setup lang="ts">
/**
 * The section index — the lazy half of the demo.
 *
 * Rendered by `<NuxtIsland name="ContentIndex" lazy>`. `lazy` governs one case
 * and it is not the obvious one: an island mounting **on the client with no
 * server-rendered markup to reuse**, which is what a client-side navigation onto
 * this page produces. Without it `<NuxtIsland>` awaits its fetch inside `setup`,
 * so the navigation waits for the island; with it the page appears at once and
 * the `#fallback` slot holds the space until the HTML arrives.
 *
 * On a **full page load** `lazy` changes nothing at all — the island is fetched
 * during SSR and inlined into the document either way. Worth knowing before
 * reaching for it to defer something below the fold: it defers a navigation, not
 * a first paint. `docs/server-islands.md` records the network trace both ways.
 *
 * The links are plain anchors. A `<NuxtLink>` here would render as an anchor
 * too, but nothing would ever bind a click handler to it — island markup is
 * inert — so it would silently behave as a full page load while claiming to be
 * a client-side navigation. In-page anchors are honest about what they do.
 */
import type { ContentIndexResponse } from '~/server/api/content/index.get'

const { sections, renderedAt } = await $fetch<ContentIndexResponse>('/api/content')
</script>

<template>
  <nav
    aria-label="Content sections"
    class="rounded-xl border border-[var(--color-border)] bg-[var(--color-muted)] p-5"
  >
    <h2 class="text-sm font-semibold text-[var(--color-foreground)]">On this page</h2>
    <ul class="mt-3 space-y-2">
      <li v-for="section in sections" :key="section.slug">
        <a
          :href="`#${section.slug}`"
          class="text-sm font-medium text-[var(--color-primary)] underline"
        >
          {{ section.title }}
        </a>
        <p class="text-xs text-[var(--color-muted-foreground)]">{{ section.summary }}</p>
      </li>
    </ul>
    <p class="mt-3 font-mono text-xs text-[var(--color-muted-foreground)]">
      fetched after hydration · rendered {{ renderedAt }}
    </p>
  </nav>
</template>
