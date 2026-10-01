<script setup lang="ts">
/**
 * Every page needs a `lang` attribute and a non-empty title; neither existed.
 *
 * Both are Level A failures that axe reports once per page — `html-has-lang`
 * (SC 3.1.1) and `document-title` (SC 2.4.2) — and `lang` is the one that changes
 * behaviour rather than just failing a rule: without it a screen reader reads the
 * page in whichever voice it was last using, so the French routes were pronounced
 * as English.
 *
 * ## Why this is not `useLocaleHead()`
 *
 * @nuxtjs/i18n's own head composable is the obvious call and was the first
 * attempt. It warns `I18n \`baseUrl\` is required to generate valid SEO tag links`
 * on every render, unconditionally — the check in its `createHeadContext` runs
 * before it looks at the `seo` option, so `seo: false` does not silence it. The
 * only way to silence it is to give `i18n.baseUrl` a canonical origin, which is a
 * deployment's own domain and not something a boilerplate can invent: the
 * placeholder would end up in `hreflang` tags pointing at a host nobody owns.
 *
 * What is wanted here is two attributes, and they are two lines. `language` is
 * the BCP 47 tag from the locale table in `nuxt.config.ts` (`en-US`, `fr-FR`),
 * which is what belongs in `lang` — `code` is the URL prefix (`en`, `fr`) and is
 * a less specific answer. `dir` travels with it rather than being left for later:
 * a right-to-left locale added to that table needs both, and a `lang` without a
 * `dir` is the half-migration that ships mirrored layouts.
 */
const { locale, locales } = useI18n()

const htmlAttrs = computed(() => {
  const active = locales.value.find((entry) => entry.code === locale.value)
  return {
    lang: active?.language ?? locale.value,
    dir: active?.dir ?? 'ltr',
  }
})

/**
 * The product name, not a translated string: it is the same word in every locale,
 * and an i18n key for it would be two files to edit for no change in output.
 */
const APP_NAME = 'Nuxt 4 Boilerplate'

const route = useRoute()

useHead(() => ({
  htmlAttrs: htmlAttrs.value,

  /**
   * `definePageMeta({ title })`, which several pages already set, is route
   * metadata that Nuxt itself does nothing with — it was configuration that
   * looked wired up and was not. Reading it here is what makes those titles
   * reach the document, and a page that would rather own its whole head still
   * calls `useSeoMeta` (pages/islands.vue) and wins, because a page component
   * resolves after the shell.
   */
  title: typeof route.meta['title'] === 'string' ? route.meta['title'] : '',

  // An empty title falls back to the product name rather than to the empty
  // string, which is what keeps `document-title` satisfied on the pages that
  // name themselves nothing.
  titleTemplate: (title?: string) =>
    title === undefined || title === '' ? APP_NAME : `${title} · ${APP_NAME}`,
}))
</script>

<template>
  <NuxtRouteAnnouncer />
  <ClientOnly>
    <div class="fixed top-4 right-4 z-50 flex items-center gap-2">
      <LanguageSwitcher />
      <ColorModeToggle />
    </div>
  </ClientOnly>
  <AppToastContainer />
  <NuxtPage />
</template>
