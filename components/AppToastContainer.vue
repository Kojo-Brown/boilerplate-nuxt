<script setup lang="ts">
const { toasts, removeToast } = useToast()
</script>

<template>
  <Teleport to="body">
    <!--
      `role="region"` is what makes the label legal, not decoration: ARIA
      prohibits `aria-label` on an element with no role (a bare `div` is
      `generic`), so axe reported `aria-prohibited-attr` here on every page —
      which also means the label was being discarded, and the live region was
      announcing toasts out of an unnamed container.

      `region` rather than `status`: `role="status"` carries an implicit
      `aria-live="polite"` and would be the obvious choice, but it also makes the
      container itself the live region's only announcement target, and this
      element outlives every toast in it. A named landmark with an explicit
      `aria-live` keeps "where am I" and "something changed" as two separate
      answers.
    -->
    <div
      class="fixed right-4 bottom-4 z-50 flex flex-col gap-2"
      style="max-width: min(400px, calc(100vw - 2rem))"
      role="region"
      aria-live="polite"
      aria-label="Notifications"
    >
      <TransitionGroup
        enter-active-class="transition-all duration-300"
        enter-from-class="opacity-0 translate-x-full"
        enter-to-class="opacity-100 translate-x-0"
        leave-active-class="transition-all duration-200"
        leave-from-class="opacity-100 scale-100"
        leave-to-class="opacity-0 scale-90"
        move-class="transition-transform duration-200"
      >
        <AppToast v-for="toast in toasts" :key="toast.id" :toast="toast" @dismiss="removeToast" />
      </TransitionGroup>
    </div>
  </Teleport>
</template>
