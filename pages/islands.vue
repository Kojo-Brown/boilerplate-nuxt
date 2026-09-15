<script setup lang="ts">
/**
 * Server islands — live demo.
 *
 * The three sections below are `components/islands/ContentSection.vue`, rendered
 * on the server and inlined into this document. Their component code is in no
 * client chunk: view source and the prose is there, open the network panel on a
 * reload and no chunk arrives to produce it. The markup renderer that built it
 * (`server/utils/content-markup.ts`) never leaves the server either.
 *
 * What *is* client code on this page: this script. The selector below changes an
 * island's props, Nuxt refetches that island's HTML, and the page swaps it in.
 * That division — behaviour on the page, content in the island — is the pattern
 * the whole feature is for.
 *
 * This page is public (`PUBLIC_PATHS` in `middleware/auth.global.ts`). Content
 * pages are the islands' home ground, and they are the pages you want cacheable
 * and reachable without a session; gating one behind login would also make every
 * island response per-user, which is the opposite of what an island is for.
 *
 * See docs/server-islands.md.
 */
import type { ContentIndexResponse } from '~/server/api/content/index.get'

definePageMeta({ layout: false, title: 'Server Islands' })

useSeoMeta({
  title: 'Server islands',
  description:
    'Content sections rendered on the server and shipped as HTML, with no client JavaScript for the component that produced them.',
})

/**
 * Only the slugs. `transform` runs before Nuxt stores the value in the payload,
 * so the document carries three strings rather than three summaries it does not
 * display — the discipline `utils/payloadBudget.ts` exists to enforce.
 */
const { data: slugs } = await useAsyncData(
  'island-content-slugs',
  () => $fetch<ContentIndexResponse>('/api/content'),
  { transform: (response) => response.sections.map((section) => section.slug) },
)

const selectedSlug = ref(slugs.value?.[0] ?? '')

/**
 * Exactly the props the island below is sent, inspected before they are sent.
 * `anchored: false` because this is a second rendering of a section already on
 * the page — two elements carrying one id is invalid HTML and breaks the index
 * island's anchors.
 */
const selectedProps = computed(() => ({ slug: selectedSlug.value, anchored: false }))
const selectedReport = computed(() => inspectIslandProps(selectedProps.value))

/**
 * A props object that breaks every rule at once. It is never passed to an
 * island — it is here so the report has something to report, because the honest
 * version of this panel on well-formed props is four empty rows.
 */
const BAD_PROPS: Record<string, unknown> = {
  slug: 'what-an-island-is',
  sessionToken: 'mock-session-token-not-a-real-one',
  renderedAt: new Date(),
  retries: Number.NaN,
  onSelect: () => {},
  body: 'x'.repeat(1200),
}

const badReport = computed(() => inspectIslandProps(BAD_PROPS))

if (import.meta.dev) {
  watchEffect(() => {
    for (const line of islandPropWarnings('ContentSection', selectedReport.value)) {
      console.warn(line)
    }
  })
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
        <h1 class="text-3xl font-bold text-[var(--color-foreground)]">Server islands</h1>
        <p class="mt-1 text-[var(--color-muted-foreground)]">
          Every section on this page was rendered by a component that is not in the client bundle.
          The HTML is in the document; the code that produced it stayed on the server.
        </p>
      </div>

      <!--
        `lazy` applies to a client-side navigation onto this page: the page
        renders immediately and the fallback below holds the space until the
        island's HTML arrives, instead of the navigation waiting for it. On a
        full page load the island is server-rendered and inlined like the rest.
      -->
      <NuxtIsland name="ContentIndex" lazy>
        <template #fallback="{ error }">
          <div
            class="rounded-xl border border-dashed border-[var(--color-border)] bg-[var(--color-muted)] p-5"
          >
            <p v-if="error" class="text-sm text-red-600">
              The index island failed to render: {{ (error as Error).message }}
            </p>
            <p v-else class="text-sm text-[var(--color-muted-foreground)]">Loading the index…</p>
          </div>
        </template>
      </NuxtIsland>

      <!-- Eager islands: fetched during SSR and inlined into this document. -->
      <NuxtIsland v-for="slug in slugs ?? []" :key="slug" name="ContentSection" :props="{ slug }" />

      <!-- Props-driven refetch -->
      <div
        class="space-y-4 rounded-xl border border-[var(--color-border)] bg-[var(--color-muted)] p-5"
      >
        <div>
          <h2 class="font-semibold text-[var(--color-foreground)]">
            Driving an island from the page
          </h2>
          <p class="mt-1 text-sm text-[var(--color-muted-foreground)]">
            This select is page code — a few bytes of behaviour. Changing it changes the island's
            props, so Nuxt fetches that island's HTML again and swaps it in. The island itself stays
            inert; it renders a duplicate of one of the sections above on purpose, so you can watch
            the same component answer to different props.
          </p>
        </div>

        <label
          for="island-section"
          class="block text-sm font-medium text-[var(--color-foreground)]"
        >
          Section
          <select
            id="island-section"
            v-model="selectedSlug"
            class="mt-1 block w-full rounded-md border border-[var(--color-border)] bg-[var(--color-background)] px-3 py-2 text-sm text-[var(--color-foreground)]"
          >
            <option v-for="slug in slugs ?? []" :key="slug" :value="slug">{{ slug }}</option>
          </select>
        </label>

        <NuxtIsland name="ContentSection" :props="selectedProps">
          <template #fallback="{ error }">
            <p class="text-sm text-red-600">
              No island for those props: {{ (error as Error)?.message ?? 'unknown error' }}
            </p>
          </template>
        </NuxtIsland>
      </div>

      <!-- Props inspection -->
      <div
        class="space-y-4 rounded-xl border border-[var(--color-border)] bg-[var(--color-muted)] p-5"
      >
        <div>
          <h2 class="font-semibold text-[var(--color-foreground)]">What goes in the URL</h2>
          <p class="mt-1 text-sm text-[var(--color-muted-foreground)]">
            Island props are serialised into the island's request URL, which makes them public,
            logged, and the cache key for the response.
            <code class="font-mono text-xs">inspectIslandProps()</code> reports what serialisation
            will do to them before they are sent.
          </p>
        </div>

        <dl class="grid grid-cols-2 gap-3 text-sm">
          <dt class="text-[var(--color-muted-foreground)]">Serialised props</dt>
          <dd class="truncate font-mono text-xs text-[var(--color-foreground)]">
            {{ selectedReport.serialised }}
          </dd>
          <dt class="text-[var(--color-muted-foreground)]">Encoded size</dt>
          <dd class="font-mono text-xs text-[var(--color-foreground)]">
            {{ selectedReport.bytes }} B / {{ selectedReport.budgetBytes }} B budget
          </dd>
          <dt class="text-[var(--color-muted-foreground)]">Issues</dt>
          <dd class="font-mono text-xs text-[var(--color-foreground)]">
            {{ selectedReport.ok ? 'none' : selectedReport.issues.length }}
          </dd>
        </dl>

        <div>
          <p class="text-sm font-medium text-[var(--color-foreground)]">
            The same check against props that break every rule
          </p>
          <ul class="mt-2 space-y-1">
            <li
              v-for="issue in badReport.issues"
              :key="`${issue.kind}:${issue.path}`"
              class="text-xs text-[var(--color-muted-foreground)]"
            >
              <span class="font-mono font-semibold text-red-600">{{ issue.kind }}</span>
              <span class="font-mono"> {{ issue.path || '(props)' }}</span> — {{ issue.detail }}
            </li>
          </ul>
        </div>
      </div>
    </div>
  </div>
</template>
