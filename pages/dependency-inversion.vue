<script setup lang="ts">
import { computed, ref } from 'vue'

import {
  createFaultyTodoGateway,
  createHttpTodoGateway,
  createInMemoryTodoGateway,
} from '../utils/todoGateway'

import type { TodoGateway, TodoItem } from '~/types/todos'

definePageMeta({ layout: false })

// ─── The subtree under test ──────────────────────────────────────────────────
// `TodoBoard`, `TodoComposer`, `TodoList` and `TodoStats` are rendered
// unchanged by every option below. None of them imports an adapter, mentions
// `$fetch`, or takes a prop describing where todos come from. The only thing
// that varies is the value this page provides.

/** Fixed ids and timestamps: the demo should look the same on every reload. */
const SEED: readonly TodoItem[] = [
  {
    id: 'seed-1',
    title: 'Read docs/provide-inject.md',
    completed: true,
    createdAt: '2026-01-01T09:00:00.000Z',
  },
  {
    id: 'seed-2',
    title: 'Swap the adapter and watch nothing else change',
    completed: false,
    createdAt: '2026-01-01T09:05:00.000Z',
  },
]

function createSeededMemoryGateway(): TodoGateway {
  let created = 0
  return createInMemoryTodoGateway({
    seed: SEED,
    nextId: () => `memory-${(created += 1)}`,
    now: () => new Date('2026-01-01T10:00:00.000Z'),
  })
}

interface AdapterOption {
  id: string
  label: string
  description: string
  create: () => TodoGateway
}

const ADAPTERS: readonly AdapterOption[] = [
  {
    id: 'memory',
    label: 'In-memory',
    description:
      'createInMemoryTodoGateway() — a real implementation of the port with no transport. No network, no database, and it enforces the same rules the API does.',
    create: createSeededMemoryGateway,
  },
  {
    id: 'flaky',
    label: 'Flaky',
    description:
      'createFaultyTodoGateway(memory, { operations: ["create"], everyNthCall: 2 }) — a decorator over the port. Every second Add rejects, so the error path is something you can look at on purpose.',
    create: () =>
      createFaultyTodoGateway(createSeededMemoryGateway(), {
        operations: ['create'],
        everyNthCall: 2,
        message: 'Could not save the todo — the service rejected it',
      }),
  },
  {
    id: 'http',
    label: 'HTTP',
    description:
      'createHttpTodoGateway() — the production adapter, talking to server/api/todos. Needs a running database; without one you get the same error UI, reported by the same components.',
    create: () => createHttpTodoGateway(),
  },
]

const adapterId = ref<string>('memory')

const adapter = computed<AdapterOption>(
  // Non-null: `adapterId` is only ever set from `ADAPTERS` below, and the list
  // is non-empty.
  () => ADAPTERS.find((option) => option.id === adapterId.value) ?? ADAPTERS[0]!,
)

// A fresh instance per selection. Adapters own their state — the in-memory one
// literally holds the todos — so reusing an instance across a switch would carry
// one backend's data into another's.
const gateway = computed<TodoGateway>(() => adapter.value.create())
</script>

<template>
  <div class="min-h-screen bg-[var(--color-background)] p-8">
    <div class="mx-auto max-w-2xl space-y-6">
      <header class="space-y-2">
        <h1 class="text-2xl font-bold text-[var(--color-foreground)]">
          provide / inject &amp; dependency inversion
        </h1>
        <p class="text-sm text-[var(--color-muted-foreground)]">
          The todo components below depend on the
          <code class="font-mono">TodoGateway</code> interface in
          <code class="font-mono">types/todos.ts</code>, never on an implementation. This page picks
          the implementation and provides it through a typed
          <code class="font-mono">InjectionKey</code>; nothing under it is aware of the choice.
        </p>
      </header>

      <!-- The seam, made visible -->
      <section
        class="space-y-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-muted)] p-6"
      >
        <h2 class="text-lg font-semibold text-[var(--color-foreground)]">Adapter</h2>

        <div class="flex flex-wrap gap-2">
          <button
            v-for="option in ADAPTERS"
            :key="option.id"
            type="button"
            class="rounded-md border px-3 py-1.5 text-sm font-medium"
            :class="
              option.id === adapterId
                ? 'border-[var(--color-primary)] bg-[var(--color-primary)] text-[var(--color-primary-foreground)]'
                : 'border-[var(--color-border)] bg-[var(--color-background)] text-[var(--color-foreground)] hover:bg-[var(--color-muted)]'
            "
            @click="adapterId = option.id"
          >
            {{ option.label }}
          </button>
        </div>

        <p class="text-xs text-[var(--color-muted-foreground)]">{{ adapter.description }}</p>
      </section>

      <!-- The subtree. `:key` remounts it on a switch, so the board reloads
           from the new backend instead of showing the old one's rows. -->
      <section class="rounded-xl border border-[var(--color-border)] bg-[var(--color-muted)] p-6">
        <TodoGatewayProvider :key="adapter.id" :gateway="gateway">
          <TodoBoard />
        </TodoGatewayProvider>
      </section>

      <section
        class="space-y-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-muted)] p-6 text-sm text-[var(--color-foreground)]"
      >
        <h2 class="text-lg font-semibold">What is actually wired</h2>
        <pre
          class="overflow-x-auto rounded-md bg-[var(--color-background)] p-4 font-mono text-xs text-[var(--color-muted-foreground)]"
        ><code>// utils/todoGateway.ts — one key, typed once
export const todoGatewayInjection = defineInjection&lt;TodoGateway&gt;('todos.gateway')

// this page, via TodoGatewayProvider
todoGatewayInjection.provide(createInMemoryTodoGateway())

// composables/useTodoList.ts — four components below, at any depth
const gateway = todoGatewayInjection.inject()   // TodoGateway, or a named throw</code></pre>
        <p class="text-[var(--color-muted-foreground)]">
          The same seam is what makes
          <code class="font-mono">tests/unit/composables/useTodoList.test.ts</code> run with no
          network, no database and no mocked globals: it passes a gateway in.
        </p>
      </section>
    </div>
  </div>
</template>
