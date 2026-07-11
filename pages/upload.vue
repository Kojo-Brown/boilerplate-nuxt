<script setup lang="ts">
import type { Upload } from '~/types/api'

const { state, uploadFile, reset } = useFileUpload()
const { data: uploads, refresh } = await useAsyncData<{ data: Upload[] }>(
  'uploads',
  () => $fetch('/api/uploads'),
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
  <div class="max-w-2xl mx-auto p-6 space-y-8">
    <h1 class="text-2xl font-semibold">File Upload</h1>

    <!-- Drop zone -->
    <div
      class="border-2 border-dashed rounded-lg p-10 text-center transition-colors cursor-pointer"
      :class="dragOver ? 'border-blue-500 bg-blue-50 dark:bg-blue-950' : 'border-gray-300 dark:border-gray-600'"
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

      <p class="text-gray-500 dark:text-gray-400">
        Drag & drop a file here, or click to select
      </p>
      <p class="text-xs text-gray-400 mt-1">
        Supported: JPEG, PNG, GIF, WebP, PDF, TXT, CSV — max 10 MB
      </p>
    </div>

    <!-- Progress -->
    <div v-if="state.isUploading || state.progress > 0" class="space-y-2">
      <div class="flex justify-between text-sm">
        <span>{{ state.isUploading ? 'Uploading…' : 'Done' }}</span>
        <span>{{ state.progress }}%</span>
      </div>
      <div class="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-2">
        <div
          class="bg-blue-500 h-2 rounded-full transition-all"
          :style="{ width: `${state.progress}%` }"
        />
      </div>
    </div>

    <!-- Error -->
    <p v-if="state.error" class="text-red-600 dark:text-red-400 text-sm">
      {{ state.error }}
    </p>

    <!-- Success -->
    <div
      v-if="state.result"
      class="p-4 bg-green-50 dark:bg-green-950 border border-green-200 dark:border-green-800 rounded-lg space-y-1"
    >
      <p class="font-medium text-green-700 dark:text-green-300">Upload successful</p>
      <p class="text-sm text-gray-600 dark:text-gray-400">{{ state.result.filename }}</p>
      <a
        :href="state.result.url"
        target="_blank"
        rel="noopener noreferrer"
        class="text-sm text-blue-600 dark:text-blue-400 underline break-all"
      >
        {{ state.result.url }}
      </a>
      <button class="text-xs text-gray-500 underline mt-2 block" @click="reset">Upload another</button>
    </div>

    <!-- Upload history -->
    <section v-if="uploads?.data.length">
      <h2 class="text-lg font-medium mb-3">Recent uploads</h2>
      <ul class="space-y-2">
        <li
          v-for="upload in uploads.data"
          :key="upload.id"
          class="flex items-center justify-between p-3 bg-gray-50 dark:bg-gray-800 rounded-lg text-sm"
        >
          <span class="truncate max-w-xs font-mono">{{ upload.filename }}</span>
          <span class="text-gray-400 ml-4 shrink-0">{{ formatBytes(upload.size) }}</span>
        </li>
      </ul>
    </section>
  </div>
</template>
