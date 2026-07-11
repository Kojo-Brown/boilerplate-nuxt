import { z } from 'zod'

const MAX_FILE_SIZE = 10 * 1024 * 1024 // 10 MB

export const ALLOWED_CONTENT_TYPES = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'application/pdf',
  'text/plain',
  'text/csv',
] as const

export type AllowedContentType = (typeof ALLOWED_CONTENT_TYPES)[number]

export const presignRequestSchema = z.object({
  filename: z.string().min(1, 'Filename is required').max(255),
  contentType: z.enum(ALLOWED_CONTENT_TYPES, {
    errorMap: () => ({ message: `Content type must be one of: ${ALLOWED_CONTENT_TYPES.join(', ')}` }),
  }),
  size: z
    .number()
    .int()
    .positive('Size must be positive')
    .max(MAX_FILE_SIZE, `File size must not exceed ${MAX_FILE_SIZE / 1024 / 1024}MB`),
})

export type PresignRequestInput = z.infer<typeof presignRequestSchema>

export const confirmUploadSchema = z.object({
  key: z.string().min(1, 'Key is required'),
  filename: z.string().min(1, 'Filename is required').max(255),
  contentType: z.enum(ALLOWED_CONTENT_TYPES),
  size: z.number().int().positive(),
  url: z.string().url('URL must be valid'),
})

export type ConfirmUploadInput = z.infer<typeof confirmUploadSchema>
