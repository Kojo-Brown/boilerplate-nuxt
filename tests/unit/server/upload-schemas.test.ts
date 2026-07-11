import { describe, it, expect } from 'vitest'
import {
  presignRequestSchema,
  confirmUploadSchema,
  ALLOWED_CONTENT_TYPES,
} from '../../../server/utils/upload-schemas'

describe('presignRequestSchema', () => {
  const valid = { filename: 'photo.jpg', contentType: 'image/jpeg', size: 1024 }

  it('accepts a valid request', () => {
    const result = presignRequestSchema.safeParse(valid)
    expect(result.success).toBe(true)
  })

  it('rejects an empty filename', () => {
    const result = presignRequestSchema.safeParse({ ...valid, filename: '' })
    expect(result.success).toBe(false)
  })

  it('rejects a disallowed content type', () => {
    const result = presignRequestSchema.safeParse({ ...valid, contentType: 'application/zip' })
    expect(result.success).toBe(false)
  })

  it('rejects zero size', () => {
    const result = presignRequestSchema.safeParse({ ...valid, size: 0 })
    expect(result.success).toBe(false)
  })

  it('rejects a file over 10 MB', () => {
    const result = presignRequestSchema.safeParse({ ...valid, size: 10 * 1024 * 1024 + 1 })
    expect(result.success).toBe(false)
  })

  it('accepts all allowed content types', () => {
    for (const contentType of ALLOWED_CONTENT_TYPES) {
      const result = presignRequestSchema.safeParse({ ...valid, contentType })
      expect(result.success, `expected ${contentType} to be accepted`).toBe(true)
    }
  })
})

describe('confirmUploadSchema', () => {
  const valid = {
    key: 'uploads/abc-123.jpg',
    filename: 'photo.jpg',
    contentType: 'image/jpeg',
    size: 1024,
    url: 'https://bucket.s3.us-east-1.amazonaws.com/uploads/abc-123.jpg',
  }

  it('accepts a valid confirmation payload', () => {
    const result = confirmUploadSchema.safeParse(valid)
    expect(result.success).toBe(true)
  })

  it('rejects an invalid URL', () => {
    const result = confirmUploadSchema.safeParse({ ...valid, url: 'not-a-url' })
    expect(result.success).toBe(false)
  })

  it('rejects an empty key', () => {
    const result = confirmUploadSchema.safeParse({ ...valid, key: '' })
    expect(result.success).toBe(false)
  })
})
