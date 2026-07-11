import { randomUUID } from 'node:crypto'
import { uploads } from '~/server/db/schema'
import { uploadToS3 } from '~/server/utils/s3'
import { ALLOWED_CONTENT_TYPES } from '~/server/utils/upload-schemas'
import type { ApiResponse } from '~/types/api'
import type { Upload } from '~/server/db/schema'

const MAX_FILE_SIZE = 10 * 1024 * 1024

export default defineEventHandler(async (event): Promise<ApiResponse<Upload>> => {
  const config = useRuntimeConfig()
  const bucket = config.s3Bucket as string

  const parts = await readMultipartFormData(event)

  if (!parts || parts.length === 0) {
    throw createError({ statusCode: 400, statusMessage: 'No file provided' })
  }

  const filePart = parts.find((p) => p.name === 'file')
  if (!filePart || !filePart.data) {
    throw createError({ statusCode: 400, statusMessage: 'Field "file" is required' })
  }

  const filename = filePart.filename ?? 'upload'
  const contentType = filePart.type ?? 'application/octet-stream'

  if (!(ALLOWED_CONTENT_TYPES as readonly string[]).includes(contentType)) {
    throw createError({
      statusCode: 415,
      statusMessage: `Unsupported media type. Allowed: ${ALLOWED_CONTENT_TYPES.join(', ')}`,
    })
  }

  if (filePart.data.length > MAX_FILE_SIZE) {
    throw createError({
      statusCode: 413,
      statusMessage: `File too large. Maximum size is ${MAX_FILE_SIZE / 1024 / 1024}MB`,
    })
  }

  const ext = filename.split('.').pop() ?? ''
  const key = `uploads/${randomUUID()}${ext ? `.${ext}` : ''}`

  const url = await uploadToS3({
    key,
    body: filePart.data,
    contentType,
    bucketName: bucket,
  })

  const db = useDb()
  const [upload] = await db
    .insert(uploads)
    .values({
      key,
      filename,
      contentType,
      size: filePart.data.length,
      url,
    })
    .returning()

  if (!upload) {
    throw createError({ statusCode: 500, statusMessage: 'Failed to record upload' })
  }

  return {
    data: upload,
    message: 'File uploaded successfully',
    statusCode: 201,
  }
})
