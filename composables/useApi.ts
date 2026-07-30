import type { ApiResponse, PaginatedResponse, Post, RequestListParams } from '~/types/api'

export function useApi() {
  const client = createApiClient()

  return {
    posts: {
      // Spread conditionally rather than passing `{ params }`: under
      // exactOptionalPropertyTypes an explicit `params: undefined` is not the
      // same as omitting the key, and ofetch's options type omits it.
      list: (params?: RequestListParams): Promise<PaginatedResponse<Post>> =>
        client('/posts', { ...(params !== undefined && { params }) }),

      getById: (id: string): Promise<ApiResponse<Post>> => client(`/posts/${id}`),
    },
  }
}
