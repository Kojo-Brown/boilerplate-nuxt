import { requireAuth } from '~/server/utils/request-auth'
import type { PaginatedResponse, Post } from '~/types/api'

export default defineEventHandler(async (event): Promise<PaginatedResponse<Post>> => {
  // `server/middleware/10.auth.ts` has already rejected an anonymous caller —
  // `/api/**` defaults to `authenticated` and nothing carves this path out. The
  // call is still here because it is what turns the middleware's guarantee into
  // a *type*: `user` below is `User`, not `User | undefined`, with no `!`.
  const { user } = requireAuth(event)

  const query = getQuery(event)
  const page = Math.max(1, Number(query['page'] ?? 1))
  const limit = Math.min(100, Math.max(1, Number(query['limit'] ?? 10)))
  const total = 100

  // Demo data — replace with Drizzle DB query once Phase 3 Drizzle item is done
  const posts: Post[] = Array.from({ length: limit }, (_, i) => {
    const postNum = (page - 1) * limit + i + 1
    return {
      id: `post-${postNum}`,
      title: `Post ${postNum}`,
      body: `This is the body of post ${postNum}.`,
      authorId: user.id,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
  })

  return {
    data: posts,
    pagination: {
      total,
      page,
      limit,
      hasMore: page * limit < total,
    },
    message: 'Posts retrieved successfully',
    statusCode: 200,
  }
})
