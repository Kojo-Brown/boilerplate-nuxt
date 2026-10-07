<script setup lang="ts">
/**
 * The live region a client-side navigation is announced through (SC 4.1.3).
 *
 * Rendered once, by `app.vue`, and deliberately outside `<NuxtPage>`: a live
 * region has to be in the document *before* its contents change, because a
 * screen reader announces a mutation to a region it is already watching and says
 * nothing about one that arrives with its text already in it. An announcer
 * rendered per page would be a new region every navigation, and silent.
 *
 * It renders empty on the server for the same reason, which is also what keeps
 * the first page load quiet: there was nothing to announce, because the document
 * the browser just loaded announced itself.
 *
 * `role="status"` is the live-region role for a non-urgent update, and carries an
 * implicit `aria-live="polite"` and `aria-atomic="true"` — atomic being what makes
 * the whole sentence read rather than the words that differ from the last one.
 * `aria-live` is stated anyway: the two are a pair everywhere else in this
 * codebase (see `AppToastContainer.vue`), and a reader should not have to know
 * ARIA's implicit table to see that this element is a live region.
 *
 * Unlike the toast container, this element *is* the announcement rather than a
 * box the announcements appear in, so `status` is right here where it was wrong
 * there — nothing lives inside it that a user would want to navigate to, and it
 * needs no accessible name.
 */
const { message } = useRouteAnnouncement()
</script>

<template>
  <p class="sr-only" role="status" aria-live="polite">{{ message }}</p>
</template>
