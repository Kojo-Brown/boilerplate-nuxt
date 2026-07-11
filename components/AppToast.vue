<script setup lang="ts">
import type { Toast } from '~/composables/useToast'

defineProps<{ toast: Toast }>()

const emit = defineEmits<{
  dismiss: [id: string]
}>()

const iconPaths: Record<Toast['type'], string> = {
  success: 'M5 13l4 4L19 7',
  error: 'M6 18L18 6M6 6l12 12',
  warning:
    'M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.734 0L3.34 16.5C2.57 18.333 3.533 20 5.072 20z',
  info: 'M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z',
}

const wrapperClasses: Record<Toast['type'], string> = {
  success: 'border-green-500 bg-green-50 text-green-800 dark:bg-green-950 dark:text-green-200',
  error: 'border-red-500 bg-red-50 text-red-800 dark:bg-red-950 dark:text-red-200',
  warning:
    'border-yellow-500 bg-yellow-50 text-yellow-800 dark:bg-yellow-950 dark:text-yellow-200',
  info: 'border-blue-500 bg-blue-50 text-blue-800 dark:bg-blue-950 dark:text-blue-200',
}

const iconClasses: Record<Toast['type'], string> = {
  success: 'text-green-500',
  error: 'text-red-500',
  warning: 'text-yellow-500',
  info: 'text-blue-500',
}
</script>

<template>
  <div
    role="alert"
    :class="[
      'flex items-start gap-3 rounded-lg border-l-4 p-4 shadow-lg',
      wrapperClasses[toast.type],
    ]"
  >
    <svg
      class="mt-0.5 h-5 w-5 shrink-0"
      :class="iconClasses[toast.type]"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      stroke-width="2"
      aria-hidden="true"
    >
      <path stroke-linecap="round" stroke-linejoin="round" :d="iconPaths[toast.type]" />
    </svg>

    <div class="min-w-0 flex-1 text-sm">
      <slot>{{ toast.message }}</slot>
    </div>

    <button
      type="button"
      class="shrink-0 opacity-60 transition-opacity hover:opacity-100 focus:outline-none"
      :aria-label="`Dismiss ${toast.type} notification`"
      @click="emit('dismiss', toast.id)"
    >
      <svg
        class="h-4 w-4"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        aria-hidden="true"
      >
        <path
          stroke-linecap="round"
          stroke-linejoin="round"
          stroke-width="2"
          d="M6 18L18 6M6 6l12 12"
        />
      </svg>
    </button>
  </div>
</template>
