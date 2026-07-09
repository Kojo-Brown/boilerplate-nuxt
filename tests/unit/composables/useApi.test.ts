import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock createApiClient so useApi doesn't need $fetch in this test
const mockClient = vi.fn()
const mockCreateApiClient = vi.fn(() => mockClient)

vi.stubGlobal('createApiClient', mockCreateApiClient)

import { useApi } from '../../../composables/useApi'

describe('useApi', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockCreateApiClient.mockReturnValue(mockClient)
  })

  it('calls createApiClient once during initialization', () => {
    useApi()
    expect(mockCreateApiClient).toHaveBeenCalledOnce()
  })

  it('returns a posts domain object', () => {
    const api = useApi()
    expect(api.posts).toBeDefined()
    expect(typeof api.posts.list).toBe('function')
    expect(typeof api.posts.getById).toBe('function')
  })

  describe('posts.list()', () => {
    it('calls the client with /posts and no params when called without arguments', () => {
      mockClient.mockResolvedValueOnce({ data: [], pagination: { total: 0, page: 1, limit: 10, hasMore: false }, message: 'ok', statusCode: 200 })
      const api = useApi()
      api.posts.list()
      expect(mockClient).toHaveBeenCalledWith('/posts', { params: undefined })
    })

    it('forwards page and limit params to the client', () => {
      mockClient.mockResolvedValueOnce({ data: [], pagination: { total: 0, page: 2, limit: 5, hasMore: false }, message: 'ok', statusCode: 200 })
      const api = useApi()
      api.posts.list({ page: 2, limit: 5 })
      expect(mockClient).toHaveBeenCalledWith('/posts', { params: { page: 2, limit: 5 } })
    })

    it('returns the promise from the client', async () => {
      const mockData = {
        data: [{ id: '1', title: 'Post 1', body: 'Body', authorId: '1', createdAt: '', updatedAt: '' }],
        pagination: { total: 1, page: 1, limit: 10, hasMore: false },
        message: 'ok',
        statusCode: 200,
      }
      mockClient.mockResolvedValueOnce(mockData)
      const api = useApi()
      const result = await api.posts.list()
      expect(result).toEqual(mockData)
    })
  })

  describe('posts.getById()', () => {
    it('calls the client with /posts/:id', () => {
      mockClient.mockResolvedValueOnce({ data: { id: 'abc', title: '', body: '', authorId: '', createdAt: '', updatedAt: '' }, message: 'ok', statusCode: 200 })
      const api = useApi()
      api.posts.getById('abc')
      expect(mockClient).toHaveBeenCalledWith('/posts/abc')
    })

    it('returns the promise from the client', async () => {
      const mockData = {
        data: { id: 'xyz', title: 'Post xyz', body: 'Body', authorId: '1', createdAt: '', updatedAt: '' },
        message: 'Post retrieved successfully',
        statusCode: 200,
      }
      mockClient.mockResolvedValueOnce(mockData)
      const api = useApi()
      const result = await api.posts.getById('xyz')
      expect(result).toEqual(mockData)
    })

    it('forwards the id in the URL path verbatim', () => {
      mockClient.mockResolvedValueOnce({})
      const api = useApi()
      api.posts.getById('post-999')
      expect(mockClient).toHaveBeenCalledWith('/posts/post-999')
    })
  })
})
