<script setup lang="ts">
import { ref } from 'vue'

import { useTodoList } from '../composables/useTodoList'

/**
 * Adds todos to the board above it.
 *
 * A sibling of `TodoList`, not its parent, and it still writes to the same
 * state — the alternative without injection is lifting `add` into the board and
 * passing it down as a prop to every component that might need it.
 */
const { add, pending } = useTodoList()

const title = ref('')

async function submit(): Promise<void> {
  const value = title.value.trim()
  if (value.length === 0) return

  // Cleared only when the gateway accepted it, so a failed add does not throw
  // away what the user typed. The board renders the error.
  if (await add(value)) {
    title.value = ''
  }
}
</script>

<template>
  <form class="flex gap-2" @submit.prevent="submit">
    <label class="sr-only" for="todo-title">New todo</label>
    <input
      id="todo-title"
      v-model="title"
      type="text"
      placeholder="What needs doing?"
      class="flex-1 rounded-md border border-[var(--color-border)] bg-[var(--color-background)] px-3 py-2 text-sm text-[var(--color-foreground)] focus:ring-2 focus:ring-[var(--color-primary)] focus:outline-none"
    />
    <button
      type="submit"
      class="rounded-md bg-[var(--color-primary)] px-4 py-2 text-sm font-medium text-[var(--color-primary-foreground)] hover:opacity-90 disabled:opacity-50"
      :disabled="pending || title.trim().length === 0"
    >
      Add
    </button>
  </form>
</template>
