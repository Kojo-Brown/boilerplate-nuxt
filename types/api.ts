export interface Post {
  id: string
  title: string
  body: string
  authorId: string
  createdAt: string
  updatedAt: string
}

export interface ApiResponse<T> {
  data: T
  message: string
  statusCode: number
}

export interface Pagination {
  total: number
  page: number
  limit: number
  hasMore: boolean
}

export interface PaginatedResponse<T> {
  data: T[]
  pagination: Pagination
  message: string
  statusCode: number
}

export interface ApiError {
  statusCode: number
  message: string
  errors?: Record<string, string[]>
}

export interface RequestListParams {
  page?: number
  limit?: number
}
