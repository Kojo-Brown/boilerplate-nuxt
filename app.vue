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
const { locale, locales, t } = useI18n()

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

/**
 * Focus and announcement for client-side navigation (SC 2.4.3, SC 4.1.3).
 *
 * Here rather than in a plugin because this is the component that renders both
 * ends of it — the `<main>` focus lands in and the live region the announcement
 * goes to — and because the message is a translated sentence, which wants a setup
 * context. `useRouteChangeA11y` decides *when*; `describe` is the only half that
 * is about language, so it is the only half passed in. See
 * `composables/useRouteChangeA11y.ts` and `docs/accessibility.md`.
 *
 * `''` means "say nothing", which is what a route with no title of its own gets.
 * `tests/unit/lint/page-titles.test.ts` is what keeps that branch unreachable
 * from `pages/`.
 */
useRouteChangeA11y({
  describe: (to) => {
    const title = pageTitle(to.meta)
    return title === null ? '' : t('a11y.navigatedTo', { title })
  },
})

useHead(() => ({
  htmlAttrs: htmlAttrs.value,

  /**
   * `definePageMeta({ title })`, which every page sets, is route metadata that
   * Nuxt itself does nothing with — it was configuration that looked wired up and
   * was not. Reading it here is what makes those titles reach the document, and a
   * page that would rather own its whole head still calls `useSeoMeta`
   * (pages/islands.vue) and wins, because a page component resolves after the
   * shell.
   *
   * Read through `pageTitle` rather than inline, because the route announcement
   * above reads the same metadata and the two have to agree: a page announced as
   * something other than what its `<title>` says is worse than one announced as
   * nothing.
   */
  title: pageTitle(route.meta) ?? '',

  // An empty title falls back to the product name rather than to the empty
  // string, which is what keeps `document-title` satisfied on the pages that
  // name themselves nothing.
  titleTemplate: (title?: string) =>
    title === undefined || title === '' ? APP_NAME : `${title} · ${APP_NAME}`,
}))
</script>

<template>
  <!--
    First, because a bypass block has to be the first focusable element in the
    document — the controls below are what it skips.
  -->
  <AppSkipLink />

  <!--
    Replaces `<NuxtRouteAnnouncer />`, which announced `document.title` on any
    head change rather than on navigation. See `composables/useRouteAnnouncement.ts`
    for the two reasons that was the wrong mechanism here, and for how it left
    announcements silent on every page that shared a title with the one before it.
  -->
  <AppRouteAnnouncer />

  <ClientOnly>
    <div class="fixed top-4 right-4 z-50 flex items-center gap-2">
      <LanguageSwitcher />
      <ColorModeToggle />
    </div>
  </ClientOnly>
  <AppToastContainer />

  <!--
    `tabindex="-1"` is not decoration: it is what makes this element a legal
    target for both the skip link's fragment and the focus reset after a
    navigation. A browser moves focus to the target of an in-page link only when
    that target is focusable, and `element.focus()` on one that is not silently
    does nothing. `-1` keeps it out of the `Tab` sequence, so the page itself
    gains no extra stop.
  -->
  <main :id="MAIN_CONTENT_ID" tabindex="-1">
    <NuxtPage />
  </main>
</template>
