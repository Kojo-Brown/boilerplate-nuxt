import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockFetch = vi.fn()
vi.stubGlobal('$fetch', mockFetch)
vi.stubGlobal('useAsyncData', vi.fn())
vi.stubGlobal('reactive', (v: object) => v)
vi.stubGlobal('readonly', (v: object) => v)
vi.stubGlobal('ref', (v: unknown) => ({ value: v }))

import { useFileUpload } from '../../../composables/useFileUpload'

const makeFile = (name = 'test.jpg', type = 'image/jpeg', size = 1024): File => {
  const blob = new Blob(['x'.repeat(size)], { type })
  return new File([blob], name, { type })
}

describe('useFileUpload', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('exposes state, uploadFile, and reset', () => {
    const { state, uploadFile, reset } = useFileUpload()
    expect(state).toBeDefined()
    expect(typeof uploadFile).toBe('function')
    expect(typeof reset).toBe('function')
  })

  it('initialises with idle state', () => {
    const { state } = useFileUpload()
    expect(state.progress).toBe(0)
    expect(state.isUploading).toBe(false)
    expect(state.error).toBeNull()
    expect(state.result).toBeNull()
  })

  it('follows the presign → S3 PUT → confirm sequence on success', async () => {
    const presignResponse = {
      data: {
        key: 'uploads/abc.jpg',
        uploadUrl: 'https://s3.example.com/presign',
        publicUrl: 'https://bucket.s3.us-east-1.amazonaws.com/uploads/abc.jpg',
      },
      message: 'ok',
      statusCode: 200,
    }
    const upload = {
      id: '1',
      key: 'uploads/abc.jpg',
      filename: 'test.jpg',
      contentType: 'image/jpeg',
      size: 1024,
      url: 'https://bucket.s3.us-east-1.amazonaws.com/uploads/abc.jpg',
      createdAt: '2026-07-11T00:00:00Z',
    }
    const confirmResponse = { data: upload, message: 'ok', statusCode: 201 }

    mockFetch
      .mockResolvedValueOnce(presignResponse) // presign
      .mockResolvedValueOnce(undefined)       // S3 PUT
      .mockResolvedValueOnce(confirmResponse) // confirm

    const { state, uploadFile } = useFileUpload()
    const result = await uploadFile(makeFile())

    expect(result).toEqual(upload)
    expect(state.result).toEqual(upload)
    expect(state.progress).toBe(100)
    expect(state.error).toBeNull()

    // Verify call order
    expect(mockFetch).toHaveBeenNthCalledWith(
      1,
      '/api/uploads/presign',
      expect.objectContaining({ method: 'POST' }),
    )
    expect(mockFetch).toHaveBeenNthCalledWith(
      2,
      'https://s3.example.com/presign',
      expect.objectContaining({ method: 'PUT' }),
    )
    expect(mockFetch).toHaveBeenNthCalledWith(
      3,
      '/api/uploads',
      expect.objectContaining({ method: 'POST' }),
    )
  })

  it('sets error state when fetch rejects', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Network error'))

    const { state, uploadFile } = useFileUpload()
    await expect(uploadFile(makeFile())).rejects.toThrow('Network error')

    expect(state.error).toBe('Network error')
    expect(state.isUploading).toBe(false)
  })

  it('reset() clears all state', async () => {
    mockFetch.mockRejectedValueOnce(new Error('fail'))
    const { state, uploadFile, reset } = useFileUpload()
    try { await uploadFile(makeFile()) } catch {}

    reset()

    expect(state.progress).toBe(0)
    expect(state.error).toBeNull()
    expect(state.result).toBeNull()
    expect(state.isUploading).toBe(false)
  })
})
