import type { ApiResponse, Post } from '~/types/api'

export default defineEventHandler(async (event): Promise<ApiResponse<Post>> => {
  const id = getRouterParam(event, 'id')

  if (!id) {
    throw createError({ statusCode: 400, message: 'Post ID is required' })
  }

  // Demo data — replace with Drizzle DB query once Phase 3 Drizzle item is done
  const post: Post = {
    id,
    title: `Post ${id}`,
    body: `This is the body of post ${id}.`,
    authorId: '1',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }

  return {
    data: post,
    message: 'Post retrieved successfully',
    statusCode: 200,
  }
})
