<script setup lang="ts">
import { useTodoList } from '../composables/useTodoList'

/**
 * Three levels below the provider — page → provider → board → list → here — and
 * still one line of wiring. This is the case injection exists for: a leaf that
 * needs shared state, and three components in between that would otherwise
 * declare a prop they only forward.
 */
const { items, remaining } = useTodoList()
</script>

<template>
  <p class="text-xs text-[var(--color-muted-foreground)]">
    {{ remaining }} of {{ items.length }} remaining
  </p>
</template>
