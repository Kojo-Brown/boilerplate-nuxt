import { randomUUID } from 'node:crypto'
import { presignRequestSchema } from '~/server/utils/upload-schemas'
import { getPresignedUploadUrl } from '~/server/utils/s3'
import type { ApiResponse } from '~/types/api'

interface PresignResponse {
  key: string
  uploadUrl: string
  publicUrl: string
}

export default defineEventHandler(async (event): Promise<ApiResponse<PresignResponse>> => {
  const config = useRuntimeConfig()
  const bucket = config.s3Bucket as string

  const body = await readBody(event)
  const parsed = presignRequestSchema.safeParse(body)

  if (!parsed.success) {
    throw createError({
      statusCode: 422,
      statusMessage: 'Validation failed',
      data: parsed.error.flatten().fieldErrors,
    })
  }

  const { filename, contentType } = parsed.data
  const ext = filename.split('.').pop() ?? ''
  const key = `uploads/${randomUUID()}${ext ? `.${ext}` : ''}`

  const uploadUrl = await getPresignedUploadUrl({ key, contentType, bucketName: bucket })
  const publicUrl = `https://${bucket}.s3.${config.awsRegion as string}.amazonaws.com/${key}`

  return {
    data: { key, uploadUrl, publicUrl },
    message: 'Presigned URL generated',
    statusCode: 200,
  }
})
