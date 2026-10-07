<script setup lang="ts">
/**
 * The bypass block (SC 2.4.1): one keystroke from the top of the document to the
 * page's own content.
 *
 * What it bypasses here is the fixed control cluster `app.vue` renders — the
 * language switcher and the colour-mode toggle — which sit before `<NuxtPage>` in
 * document order and so are the first two stops of every `Tab` sequence on every
 * page. Two is not many; the point is that it is two *on every page*, and the
 * number only ever grows.
 *
 * It must be the first focusable element in the document, which is why `app.vue`
 * renders it first. A skip link that comes after the thing it skips is a link to
 * where the user already is.
 *
 * ## Why this is a plain `<a>` and not a `<NuxtLink>`
 *
 * The whole mechanism is the browser's: an in-page fragment link whose target is
 * focusable moves focus to that target, and `app.vue` gives `<main>`
 * `tabindex="-1"` for exactly that reason. `<NuxtLink>` would hand the click to
 * vue-router, which resolves it as a route change and does not move focus at all —
 * the link would scroll and silently leave focus behind, which is the failure this
 * component exists to fix.
 *
 * The resulting hash change is not a page navigation and
 * `utils/routeNavigation.ts` is careful not to treat it as one; otherwise using
 * the skip link would announce the page you were already on.
 *
 * ## Why it is moved rather than hidden
 *
 * `sr-only` would make this a 1×1 clipped box that becomes a real one on focus.
 * It is kept at full size and translated out of the viewport instead, so the box
 * a browser measures is the box a user sees — `target-size` (SC 2.5.8, the one
 * WCAG 2.2 AA rule axe implements, and the rule `tests/e2e/a11y.test.ts` proves
 * ran) measures the element's bounding rectangle, and a 1×1 one is only not a
 * violation because something happens to be painted over it.
 */
const { t } = useI18n()
</script>

<template>
  <a
    :href="`#${MAIN_CONTENT_ID}`"
    class="fixed top-0 left-4 z-[100] -translate-y-full rounded-b-md bg-[var(--color-primary)] px-4 py-2 text-sm font-medium text-[var(--color-primary-foreground)] transition-transform focus:translate-y-0 focus:ring-2 focus:ring-[var(--color-primary)] focus:ring-offset-2 focus:outline-none motion-reduce:transition-none"
  >
    {{ t('a11y.skipToContent') }}
  </a>
</template>
