<script setup lang="ts">
import type { ColorModePreference } from '@/composables/useAppColorMode'

interface Props {
  variant?: 'icon' | 'segmented'
}

withDefaults(defineProps<Props>(), {
  variant: 'icon',
})

const { isDark, preference, set, toggle } = useAppColorMode()

const modes: { value: ColorModePreference; label: string }[] = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
  { value: 'system', label: 'System' },
]
</script>

<template>
  <!-- Icon toggle: click to switch between light and dark -->
  <button
    v-if="variant === 'icon'"
    type="button"
    :aria-label="isDark ? 'Switch to light mode' : 'Switch to dark mode'"
    :title="isDark ? 'Switch to light mode' : 'Switch to dark mode'"
    class="flex h-9 w-9 items-center justify-center rounded-lg border border-[var(--color-border)] bg-[var(--color-background)] text-[var(--color-foreground)] transition-colors hover:bg-[var(--color-muted)]"
    @click="toggle"
  >
    <!-- Sun — shown in dark mode to indicate clicking switches to light -->
    <svg
      v-if="isDark"
      xmlns="http://www.w3.org/2000/svg"
      class="h-4 w-4"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="4" />
      <path
        d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"
      />
    </svg>
    <!-- Moon — shown in light/system mode to indicate clicking switches to dark -->
    <svg
      v-else
      xmlns="http://www.w3.org/2000/svg"
      class="h-4 w-4"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  </button>

  <!-- Segmented control: explicit three-way selector (light / dark / system) -->
  <div
    v-else
    role="group"
    aria-label="Color mode"
    class="flex rounded-lg border border-[var(--color-border)] bg-[var(--color-muted)] p-0.5"
  >
    <button
      v-for="mode in modes"
      :key="mode.value"
      type="button"
      :aria-pressed="preference === mode.value"
      class="rounded-md px-3 py-1 text-xs font-medium transition-colors"
      :class="
        preference === mode.value
          ? 'bg-[var(--color-background)] text-[var(--color-foreground)] shadow-sm'
          : 'text-[var(--color-muted-foreground)] hover:text-[var(--color-foreground)]'
      "
      @click="set(mode.value)"
    >
      {{ mode.label }}
    </button>
  </div>
</template>
