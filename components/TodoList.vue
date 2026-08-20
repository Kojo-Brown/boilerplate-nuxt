<script setup lang="ts">
import { useTodoList } from '../composables/useTodoList'

/**
 * Renders the rows of the board above it, and nests `TodoStats` below itself —
 * which reaches the same controller a further level down without this component
 * forwarding anything.
 */
const { items, loaded, pending, toggle, remove } = useTodoList()
</script>

<template>
  <div class="space-y-3">
    <p v-if="!loaded" class="text-sm text-[var(--color-muted-foreground)]">Loading…</p>

    <p v-else-if="items.length === 0" class="text-sm text-[var(--color-muted-foreground)]">
      Nothing here yet.
    </p>

    <ul v-else class="divide-y divide-[var(--color-border)]">
      <li v-for="item in items" :key="item.id" class="flex items-center gap-3 py-2">
        <input
          :id="`todo-${item.id}`"
          type="checkbox"
          class="h-4 w-4 accent-[var(--color-primary)]"
          :checked="item.completed"
          :disabled="pending"
          @change="toggle(item.id)"
        />
        <label
          :for="`todo-${item.id}`"
          class="flex-1 text-sm text-[var(--color-foreground)]"
          :class="item.completed && 'text-[var(--color-muted-foreground)] line-through'"
        >
          {{ item.title }}
        </label>
        <button
          type="button"
          class="rounded px-2 py-1 text-xs font-medium text-red-600 hover:bg-red-500/10 disabled:opacity-50 dark:text-red-400"
          :disabled="pending"
          :aria-label="`Delete ${item.title}`"
          @click="remove(item.id)"
        >
          Delete
        </button>
      </li>
    </ul>

    <TodoStats />
  </div>
</template>
