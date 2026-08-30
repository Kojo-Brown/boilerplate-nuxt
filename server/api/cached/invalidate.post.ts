import { cacheInvalidationSchema } from '~/server/utils/cache-schemas'
import { invalidateTags } from '~/server/utils/cached-route'
import type { ApiResponse } from '~/types/api'

/**
 * Drops every cached entry carrying any of the given tags.
 *
 * ## Why this one route is authenticated when its neighbours are not
 *
 * The two `/api/cached/**` read routes are `public` in
 * `server/utils/access-policy.ts` for the reason a cached route always is: one
 * stored response is served to everybody, so it must not depend on who asked.
 *
 * This route is the opposite. It costs a re-render of everything it touches, and
 * an unauthenticated caller in a loop is a cache-stampede button — the cache
 * stops absorbing load and every request reaches the origin. So the access
 * policy carves it back out with an exact key, which beats the surrounding
 * wildcard, and it is behind a session like the rest of `/api/**`.
 *
 * In a real deployment the caller is usually not a browser at all: it is the
 * code that just changed the data — a `POST /api/todos` handler, a webhook from
 * a CMS, a migration. Those call `invalidateTags()` directly rather than making
 * an HTTP request to themselves. This route is what makes the mechanism
 * demonstrable from `/cached-functions`, and the place to look when wiring the
 * real thing.
 */
export default defineEventHandler(async (event): Promise<ApiResponse<InvalidationSummary>> => {
  requireAuth(event)

  const parsed = cacheInvalidationSchema.safeParse(await readBody(event))

  if (!parsed.success) {
    throw createError({
      statusCode: 400,
      message: parsed.error.issues[0]?.message ?? 'Invalid request body',
    })
  }

  const { tags, entries } = await invalidateTags(parsed.data.tags)

  return {
    data: { tags: [...tags], entries: [...entries], removed: entries.length },
    message:
      entries.length === 0
        ? 'Nothing was cached under those tags'
        : `Removed ${entries.length} cache ${entries.length === 1 ? 'entry' : 'entries'}`,
    statusCode: 200,
  }
})

export interface InvalidationSummary {
  /** The tags that were swept, normalised: trimmed, deduplicated, sorted. */
  tags: string[]
  /**
   * The storage keys removed. Returned because the useful thing to see when a
   * tag does not do what you expected is *which* entries it reached — an empty
   * list next to a tag you were sure was live is the answer, not a silence.
   */
  entries: string[]
  removed: number
}
