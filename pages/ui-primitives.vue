<script setup lang="ts">
definePageMeta({ title: 'UI Primitives' })

const { success, error, warning, info } = useToast()

const showBasicModal = ref(false)
const showSlottedModal = ref(false)
const showConfirmModal = ref(false)
</script>

<template>
  <div class="min-h-screen bg-[var(--color-background)] p-8">
    <div class="mx-auto max-w-4xl space-y-12">
      <div>
        <h1 class="text-3xl font-bold text-[var(--color-foreground)]">UI Primitives</h1>
        <p class="mt-2 text-[var(--color-muted-foreground)]">
          Slot-based component library: Button, Modal, Toast
        </p>
      </div>

      <!-- AppButton -->
      <section class="space-y-4">
        <h2 class="text-xl font-semibold text-[var(--color-foreground)]">AppButton</h2>

        <div class="space-y-3">
          <h3 class="text-sm font-medium text-[var(--color-muted-foreground)]">Variants</h3>
          <div class="flex flex-wrap gap-3">
            <AppButton variant="primary">Primary</AppButton>
            <AppButton variant="secondary">Secondary</AppButton>
            <AppButton variant="outline">Outline</AppButton>
            <AppButton variant="ghost">Ghost</AppButton>
            <AppButton variant="danger">Danger</AppButton>
          </div>
        </div>

        <div class="space-y-3">
          <h3 class="text-sm font-medium text-[var(--color-muted-foreground)]">Sizes</h3>
          <div class="flex flex-wrap items-center gap-3">
            <AppButton size="sm">Small</AppButton>
            <AppButton size="md">Medium</AppButton>
            <AppButton size="lg">Large</AppButton>
          </div>
        </div>

        <div class="space-y-3">
          <h3 class="text-sm font-medium text-[var(--color-muted-foreground)]">States</h3>
          <div class="flex flex-wrap gap-3">
            <AppButton :loading="true">Loading</AppButton>
            <AppButton :disabled="true">Disabled</AppButton>
            <AppButton full-width>Full Width</AppButton>
          </div>
        </div>
      </section>

      <!-- AppModal -->
      <section class="space-y-4">
        <h2 class="text-xl font-semibold text-[var(--color-foreground)]">AppModal</h2>
        <div class="flex flex-wrap gap-3">
          <AppButton @click="showBasicModal = true">Basic Modal</AppButton>
          <AppButton variant="outline" @click="showSlottedModal = true">Custom Slots</AppButton>
          <AppButton variant="danger" @click="showConfirmModal = true">Confirm Dialog</AppButton>
        </div>
      </section>

      <!-- AppToast -->
      <section class="space-y-4">
        <h2 class="text-xl font-semibold text-[var(--color-foreground)]">AppToast</h2>
        <div class="flex flex-wrap gap-3">
          <AppButton variant="primary" @click="success('Operation completed successfully!')">
            Success
          </AppButton>
          <AppButton variant="danger" @click="error('Something went wrong. Please try again.')">
            Error
          </AppButton>
          <AppButton variant="outline" @click="warning('This action cannot be undone.')">
            Warning
          </AppButton>
          <AppButton variant="secondary" @click="info('New features are now available.')">
            Info
          </AppButton>
          <AppButton variant="ghost" @click="info('This toast will not auto-dismiss.', 0)">
            Persistent
          </AppButton>
        </div>
      </section>
    </div>

    <!-- Basic modal -->
    <AppModal v-model="showBasicModal" title="Basic Modal">
      <p class="text-[var(--color-foreground)]">
        This is a basic modal with a title prop and default slot body.
      </p>
      <template #footer>
        <div class="flex justify-end gap-2 border-t border-[var(--color-border)] px-6 py-4">
          <AppButton variant="outline" @click="showBasicModal = false">Cancel</AppButton>
          <AppButton @click="showBasicModal = false">Confirm</AppButton>
        </div>
      </template>
    </AppModal>

    <!-- Custom-slotted modal -->
    <AppModal v-model="showSlottedModal" size="lg">
      <template #header>
        <div
          class="flex items-center gap-3 border-b border-[var(--color-border)] px-6 py-4"
        >
          <div
            class="flex h-10 w-10 items-center justify-center rounded-full bg-[var(--color-primary)] text-lg text-[var(--color-primary-foreground)]"
          >
            ✨
          </div>
          <div>
            <h2 class="font-semibold text-[var(--color-foreground)]">Custom Header Slot</h2>
            <p class="text-sm text-[var(--color-muted-foreground)]">
              Full control over every modal region
            </p>
          </div>
        </div>
      </template>
      <p class="text-[var(--color-foreground)]">
        The <code class="rounded bg-[var(--color-muted)] px-1 py-0.5 text-sm">header</code>,
        <code class="rounded bg-[var(--color-muted)] px-1 py-0.5 text-sm">default</code>, and
        <code class="rounded bg-[var(--color-muted)] px-1 py-0.5 text-sm">footer</code> slots
        are all independently replaceable.
      </p>
      <template #footer>
        <div class="flex justify-end px-6 py-4">
          <AppButton variant="outline" @click="showSlottedModal = false">Close</AppButton>
        </div>
      </template>
    </AppModal>

    <!-- Confirm modal -->
    <AppModal
      v-model="showConfirmModal"
      title="Confirm Delete"
      size="sm"
      :close-on-backdrop="false"
    >
      <p class="text-[var(--color-foreground)]">
        Are you sure? This action cannot be undone.
      </p>
      <template #footer>
        <div class="flex gap-2 border-t border-[var(--color-border)] px-6 py-4">
          <AppButton variant="outline" full-width @click="showConfirmModal = false">
            Cancel
          </AppButton>
          <AppButton
            variant="danger"
            full-width
            @click="() => { showConfirmModal = false; error('Item deleted.') }"
          >
            Delete
          </AppButton>
        </div>
      </template>
    </AppModal>
  </div>
</template>
