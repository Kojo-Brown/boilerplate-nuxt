<script setup lang="ts">
import { onMounted } from 'vue'

import { provideTodoList } from '../composables/useTodoList'

/**
 * Owns one todo list and publishes it to everything below.
 *
 * Note what this component never learns: which gateway it got. It calls
 * `provideTodoList()`, which injects whatever `TodoGatewayProvider` supplied,
 * so the same board renders against the in-memory adapter, the HTTP adapter, or
 * a failing decorator with no branch anywhere in this file.
 */
const board = provideTodoList()

// Destructured, so the template reads `pending` rather than `board.pending.value`
// — a top-level ref in `<script setup>` is unwrapped in the template, a ref
// reached through an object is not.
const { pending, error, refresh } = board

// The first load happens on the client. The in-memory adapter would render on
// the server just as well, but the HTTP one needs a session and a database, and
// a demo page should not fail SSR because a backend is not running.
onMounted(() => {
  void refresh()
})
</script>

<template>
  <div class="space-y-4">
    <div class="flex items-center justify-between gap-4">
      <h2 class="text-lg font-semibold text-[var(--color-foreground)]">Todos</h2>
      <button
        class="rounded-md border border-[var(--color-border)] bg-[var(--color-background)] px-3 py-1 text-xs font-medium text-[var(--color-foreground)] hover:bg-[var(--color-muted)] disabled:opacity-50"
        :disabled="pending"
        @click="refresh()"
      >
        {{ pending ? 'Working…' : 'Refresh' }}
      </button>
    </div>

    <p
      v-if="error"
      class="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-600 dark:text-red-400"
      role="alert"
    >
      {{ error.message }}
    </p>

    <!-- Neither child is passed the list, the gateway, or a callback. -->
    <TodoComposer />
    <TodoList />
  </div>
</template>
