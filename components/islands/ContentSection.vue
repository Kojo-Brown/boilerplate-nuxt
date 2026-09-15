<script setup lang="ts">
/**
 * A content section, rendered on the server and shipped as HTML.
 *
 * Everything about this component is ordinary Vue; what makes it an island is
 * where it lives. `components/islands/` is scanned as an island directory when
 * `experimental.componentIslands` is on, so this file is compiled into the
 * server bundle and into no client chunk, and the page renders it through
 * `<NuxtIsland name="ContentSection" :props="{ slug }" />` rather than by tag.
 *
 * Three constraints come with that, and all three are load-bearing here:
 *
 *  - **No interactivity.** There is no client-side instance behind this markup,
 *    so a handler would never fire and a `ref` would never update. There are
 *    none.
 *  - **Fetch, don't receive.** The prop is a slug; the body arrives from
 *    `/api/content/[slug]`. Passing the rendered section in as a prop would put
 *    the whole body in the island's URL — see `utils/islandProps.ts`.
 *  - **Top-level `await` is fine.** The island endpoint renders this inside a
 *    Suspense boundary of its own, so an async `setup` is the supported shape;
 *    `useAsyncData` would only add a payload nobody hydrates.
 *
 * `v-html` is safe here because `server/utils/content-markup.ts` escapes every
 * character of the source before it applies a single markup rule — the ordering
 * argument is in that file's header, and the escaping is pinned by
 * `tests/unit/server/content-markup.test.ts`.
 */
import type { ContentSectionResponse } from '~/server/api/content/[slug].get'

const props = withDefaults(
  defineProps<{
    slug: string
    /**
     * Whether to carry the slug as an element id. True for a section rendered
     * into a page — that is what the index island's anchors point at — and false
     * for a second rendering of the same section elsewhere on the page, which
     * would otherwise duplicate the id.
     *
     * It is also a second prop, which means a second island URL and a second
     * cache entry: an anchored and an unanchored rendering of one section are
     * two different responses.
     */
    anchored?: boolean
  }>(),
  { anchored: true },
)

// `encodeURIComponent` because the slug arrives from the island's query string:
// it is whatever the caller put there, not necessarily one of ours.
const { section, renderedAt } = await $fetch<ContentSectionResponse>(
  `/api/content/${encodeURIComponent(props.slug)}`,
)
</script>

<template>
  <section
    :id="anchored ? section.slug : undefined"
    class="scroll-mt-8 rounded-xl border border-[var(--color-border)] bg-[var(--color-muted)] p-6"
  >
    <header class="mb-4 border-b border-[var(--color-border)] pb-4">
      <h2 class="text-xl font-semibold text-[var(--color-foreground)]">{{ section.title }}</h2>
      <p class="mt-1 text-sm text-[var(--color-muted-foreground)]">{{ section.summary }}</p>
      <p class="mt-2 font-mono text-xs text-[var(--color-muted-foreground)]">
        updated {{ section.updatedAt }} · rendered {{ renderedAt }} · 0 bytes of component JS
      </p>
    </header>

    <!--
      `vue/no-v-html` is silenced here and nowhere else in this app. The HTML
      comes from `server/utils/content-markup.ts`, which escapes every character
      of its source *before* it applies a single markup rule — the ordering
      argument is in that file's header and the escaping is pinned by
      `tests/unit/server/content-markup.test.ts`. The directive has to be its own
      single-line comment: ESLint resolves `disable-next-line` against the line
      the comment starts on, so a wrapped one would disable the wrong line.
    -->
    <!-- eslint-disable-next-line vue/no-v-html -->
    <div class="island-prose text-[var(--color-foreground)]" v-html="section.html" />
  </section>
</template>

<style scoped>
/*
 * The rendered markup has no classes on it — it comes from a string, not from a
 * template — so it is styled by element. Scoped styles work in an island: the
 * scope attribute is applied during the server render like any other, and the
 * stylesheet is part of the island's response.
 */
.island-prose :deep(p) {
  margin-bottom: 0.75rem;
  line-height: 1.7;
}

.island-prose :deep(p:last-child),
.island-prose :deep(ul:last-child) {
  margin-bottom: 0;
}

.island-prose :deep(h3) {
  margin-top: 1.5rem;
  margin-bottom: 0.5rem;
  font-size: 1rem;
  font-weight: 600;
}

.island-prose :deep(ul) {
  margin-bottom: 0.75rem;
  list-style-type: disc;
  padding-left: 1.25rem;
}

.island-prose :deep(li) {
  margin-bottom: 0.25rem;
  line-height: 1.6;
}

.island-prose :deep(code) {
  border-radius: 0.25rem;
  background-color: var(--color-background);
  padding: 0.1rem 0.3rem;
  font-family: ui-monospace, monospace;
  font-size: 0.8125rem;
}

.island-prose :deep(pre) {
  margin-bottom: 0.75rem;
  overflow-x: auto;
  border-radius: 0.5rem;
  border: 1px solid var(--color-border);
  background-color: var(--color-background);
  padding: 0.75rem;
}

.island-prose :deep(pre code) {
  background-color: transparent;
  padding: 0;
}

.island-prose :deep(a) {
  color: var(--color-primary);
  text-decoration: underline;
}
</style>
