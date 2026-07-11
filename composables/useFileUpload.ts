import type { ApiResponse, Upload, PresignResponse } from '~/types/api'

export interface FileUploadState {
  progress: number
  isUploading: boolean
  error: string | null
  result: Upload | null
}

export interface UseFileUploadReturn {
  state: Readonly<FileUploadState>
  uploadFile: (file: File) => Promise<Upload>
  reset: () => void
}

export function useFileUpload(): UseFileUploadReturn {
  const state = reactive<FileUploadState>({
    progress: 0,
    isUploading: false,
    error: null,
    result: null,
  })

  function reset(): void {
    state.progress = 0
    state.isUploading = false
    state.error = null
    state.result = null
  }

  async function uploadFile(file: File): Promise<Upload> {
    reset()
    state.isUploading = true

    try {
      // Step 1: obtain a presigned PUT URL from the server
      const presign = await $fetch<ApiResponse<PresignResponse>>('/api/uploads/presign', {
        method: 'POST',
        body: { filename: file.name, contentType: file.type, size: file.size },
      })

      state.progress = 20

      // Step 2: PUT the file directly to S3
      await $fetch(presign.data.uploadUrl, {
        method: 'PUT',
        body: file,
        headers: { 'Content-Type': file.type },
      })

      state.progress = 80

      // Step 3: record the upload in our database
      const confirmed = await $fetch<ApiResponse<Upload>>('/api/uploads', {
        method: 'POST',
        body: {
          key: presign.data.key,
          filename: file.name,
          contentType: file.type,
          size: file.size,
          url: presign.data.publicUrl,
        },
      })

      state.progress = 100
      state.result = confirmed.data
      return confirmed.data
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Upload failed'
      state.error = message
      throw err
    } finally {
      state.isUploading = false
    }
  }

  return { state: readonly(state) as Readonly<FileUploadState>, uploadFile, reset }
}
