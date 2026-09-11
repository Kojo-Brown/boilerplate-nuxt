<script setup lang="ts">
import { computed } from 'vue'

import { useTodoList } from '../composables/useTodoList'
import { conflictRows, intentLabel } from '../utils/todoConflictView'

/**
 * The conflict UI: what the user sees when somebody else wrote first.
 *
 * It renders from the shared controller and takes no props, like every other
 * component on this board — the collision is board state, not something a parent
 * hands down.
 *
 * ## Why a dialog and not a toast
 *
 * A conflict is the one failure in this app that cannot be resolved without the
 * user. A toast would let them keep clicking while a write of theirs is still
 * unapplied, and the second click would collide with the same stale version and
 * raise the same toast — which is how a conflict turns into a loop nobody can
 * escape. A modal states the two versions and asks for the one thing that
 * settles it.
 *
 * ## Both versions are shown, not just the winner
 *
 * The dialog names the fields that actually differ. "Someone else changed this,
 * try again" is the version of this UI that is easy to write and useless to
 * receive: the user cannot tell whether the other change is compatible with
 * theirs, so they either overwrite it blindly or abandon their own work. The
 * comparison itself lives in `utils/todoConflictView.ts`, where it can be
 * tested — a diff that misses a changed field invites exactly the overwrite this
 * dialog exists to prevent.
 */
const { conflict, pending, keepMine, keepTheirs } = useTodoList()

const state = computed(() => conflict.value)
const open = computed(() => state.value !== null)
const wasDeleted = computed(() => state.value !== null && state.value.theirs === null)
const rows = computed(() => (state.value === null ? [] : conflictRows(state.value)))
const action = computed(() => (state.value === null ? '' : intentLabel(state.value.intent)))

/** `AppModal` closes through `v-model`; closing is "keep theirs". */
function onUpdateOpen(next: boolean): void {
  if (!next) keepTheirs()
}
</script>

<template>
  <AppModal
    :model-value="open"
    title="Someone else edited this todo"
    size="lg"
    :close-on-backdrop="false"
    @update:model-value="onUpdateOpen"
  >
    <div v-if="state" class="space-y-4">
      <p class="text-sm text-[var(--color-muted-foreground)]">
        You tried to {{ action }}, but
        <template v-if="wasDeleted">it was deleted before your change was saved.</template>
        <template v-else>
          it changed after you loaded it. Your copy is version {{ state.mine.version }}; the saved
          one is version {{ state.theirs?.version }}.
        </template>
      </p>

      <div
        v-if="wasDeleted"
        class="rounded-md border border-[var(--color-border)] bg-[var(--color-muted)] px-3 py-2 text-sm text-[var(--color-foreground)]"
      >
        There is nothing left to merge with. Your change cannot be saved onto a todo that no longer
        exists, so the only thing left to do is let it go.
      </div>

      <div v-else class="overflow-x-auto">
        <table class="w-full border-collapse text-left text-sm">
          <thead>
            <tr class="border-b border-[var(--color-border)]">
              <th scope="col" class="py-2 pr-4 font-medium text-[var(--color-muted-foreground)]">
                Field
              </th>
              <th scope="col" class="py-2 pr-4 font-medium text-[var(--color-foreground)]">
                Your change
              </th>
              <th scope="col" class="py-2 font-medium text-[var(--color-foreground)]">Saved now</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="row in rows"
              :key="row.label"
              class="border-b border-[var(--color-border)] last:border-0"
            >
              <th scope="row" class="py-2 pr-4 font-normal text-[var(--color-muted-foreground)]">
                {{ row.label }}
              </th>
              <td
                class="py-2 pr-4 text-[var(--color-foreground)]"
                :class="row.differs && 'font-medium'"
              >
                {{ row.mine }}
              </td>
              <td class="py-2 text-[var(--color-foreground)]" :class="row.differs && 'font-medium'">
                {{ row.theirs }}
                <!-- Marked in text as well as in weight: a difference carried
                     only by boldness is invisible to a screen reader, and to
                     anyone who cannot pick the two weights apart. -->
                <span v-if="row.differs" class="sr-only">(differs from your change)</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <template #footer>
      <div class="flex flex-wrap justify-end gap-2 border-t border-[var(--color-border)] px-6 py-4">
        <button
          type="button"
          class="rounded-md border border-[var(--color-border)] bg-[var(--color-background)] px-3 py-2 text-sm font-medium text-[var(--color-foreground)] hover:bg-[var(--color-muted)] disabled:opacity-50"
          :disabled="pending"
          @click="keepTheirs()"
        >
          {{ wasDeleted ? 'Remove it from my list' : 'Discard my change' }}
        </button>
        <button
          v-if="!wasDeleted"
          type="button"
          class="rounded-md bg-[var(--color-primary)] px-3 py-2 text-sm font-medium text-[var(--color-primary-foreground)] hover:opacity-90 disabled:opacity-50"
          :disabled="pending"
          @click="keepMine()"
        >
          Apply my change anyway
        </button>
      </div>
    </template>
  </AppModal>
</template>
