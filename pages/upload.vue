<script setup lang="ts">
import type { Upload } from '~/types/api'

const { state, uploadFile, reset } = useFileUpload()
const { data: uploads, refresh } = await useAsyncData<{ data: Upload[] }>('uploads', () =>
  $fetch('/api/uploads'),
)

const fileInput = ref<HTMLInputElement | null>(null)
const dragOver = ref(false)

async function handleFile(file: File): Promise<void> {
  await uploadFile(file)
  await refresh()
}

async function onFileChange(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (file) await handleFile(file)
}

async function onDrop(event: DragEvent): Promise<void> {
  dragOver.value = false
  const file = event.dataTransfer?.files[0]
  if (file) await handleFile(file)
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
</script>

<template>
  <div class="mx-auto max-w-2xl space-y-8 p-6">
    <h1 class="text-2xl font-semibold">File Upload</h1>

    <!-- Drop zone -->
    <div
      class="cursor-pointer rounded-lg border-2 border-dashed p-10 text-center transition-colors"
      :class="
        dragOver
          ? 'border-blue-500 bg-blue-50 dark:bg-blue-950'
          : 'border-gray-300 dark:border-gray-600'
      "
      @dragover.prevent="dragOver = true"
      @dragleave="dragOver = false"
      @drop.prevent="onDrop"
      @click="fileInput?.click()"
    >
      <input
        ref="fileInput"
        type="file"
        class="hidden"
        accept="image/jpeg,image/png,image/gif,image/webp,application/pdf,text/plain,text/csv"
        @change="onFileChange"
      />

      <p class="text-gray-500 dark:text-gray-400">Drag & drop a file here, or click to select</p>
      <p class="mt-1 text-xs text-gray-400">
        Supported: JPEG, PNG, GIF, WebP, PDF, TXT, CSV — max 10 MB
      </p>
    </div>

    <!-- Progress -->
    <div v-if="state.isUploading || state.progress > 0" class="space-y-2">
      <div class="flex justify-between text-sm">
        <span>{{ state.isUploading ? 'Uploading…' : 'Done' }}</span>
        <span>{{ state.progress }}%</span>
      </div>
      <div class="h-2 w-full rounded-full bg-gray-200 dark:bg-gray-700">
        <div
          class="h-2 rounded-full bg-blue-500 transition-all"
          :style="{ width: `${state.progress}%` }"
        />
      </div>
    </div>

    <!-- Error -->
    <p v-if="state.error" class="text-sm text-red-600 dark:text-red-400">
      {{ state.error }}
    </p>

    <!-- Success -->
    <div
      v-if="state.result"
      class="space-y-1 rounded-lg border border-green-200 bg-green-50 p-4 dark:border-green-800 dark:bg-green-950"
    >
      <p class="font-medium text-green-700 dark:text-green-300">Upload successful</p>
      <p class="text-sm text-gray-600 dark:text-gray-400">{{ state.result.filename }}</p>
      <a
        :href="state.result.url"
        target="_blank"
        rel="noopener noreferrer"
        class="text-sm break-all text-blue-600 underline dark:text-blue-400"
      >
        {{ state.result.url }}
      </a>
      <button class="mt-2 block text-xs text-gray-500 underline" @click="reset">
        Upload another
      </button>
    </div>

    <!-- Upload history -->
    <section v-if="uploads?.data.length">
      <h2 class="mb-3 text-lg font-medium">Recent uploads</h2>
      <ul class="space-y-2">
        <li
          v-for="upload in uploads.data"
          :key="upload.id"
          class="flex items-center justify-between rounded-lg bg-gray-50 p-3 text-sm dark:bg-gray-800"
        >
          <span class="max-w-xs truncate font-mono">{{ upload.filename }}</span>
          <span class="ml-4 shrink-0 text-gray-400">{{ formatBytes(upload.size) }}</span>
        </li>
      </ul>
    </section>
  </div>
</template>
