import type { ApiResponse, PaginatedResponse, Post, RequestListParams } from '~/types/api'

export function useApi() {
  const client = createApiClient()

  return {
    posts: {
      list: (params?: RequestListParams): Promise<PaginatedResponse<Post>> =>
        client('/posts', { params }),

      getById: (id: string): Promise<ApiResponse<Post>> =>
        client(`/posts/${id}`),
    },
  }
}
