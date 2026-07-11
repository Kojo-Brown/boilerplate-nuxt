import { confirmUploadSchema } from '~/server/utils/upload-schemas'
import { uploads } from '~/server/db/schema'
import type { ApiResponse } from '~/types/api'
import type { Upload } from '~/server/db/schema'

export default defineEventHandler(async (event): Promise<ApiResponse<Upload>> => {
  const body = await readBody(event)
  const parsed = confirmUploadSchema.safeParse(body)

  if (!parsed.success) {
    throw createError({
      statusCode: 422,
      statusMessage: 'Validation failed',
      data: parsed.error.flatten().fieldErrors,
    })
  }

  const db = useDb()
  const [upload] = await db.insert(uploads).values(parsed.data).returning()

  if (!upload) {
    throw createError({ statusCode: 500, statusMessage: 'Failed to record upload' })
  }

  return {
    data: upload,
    message: 'Upload recorded',
    statusCode: 201,
  }
})
