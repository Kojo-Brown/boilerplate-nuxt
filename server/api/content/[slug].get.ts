import type { H3Event } from 'h3'

import type { RenderedContentSection } from '~/server/utils/content'
import { findContentSection, renderContentSection } from '~/server/utils/content'

/**
 * One rendered content section — what `components/islands/ContentSection.vue`
 * fetches.
 *
 * The island passes a slug and this route does the rendering, which is the
 * arrangement that keeps `server/utils/content-markup.ts` out of the client
 * bundle even if the island is later turned back into an ordinary component by
 * someone who did not read `docs/server-islands.md`.
 *
 * An unknown slug is a 404 rather than an empty section: the island surfaces the
 * failure through `<NuxtIsland>`'s `#fallback` slot, so a mistyped slug is
 * visible on the page instead of rendering as a blank gap.
 */
export interface ContentSectionResponse {
  readonly section: RenderedContentSection
  readonly renderedAt: string
}

export default defineEventHandler((event: H3Event): ContentSectionResponse => {
  const slug = getRouterParam(event, 'slug')

  if (!slug) {
    throw createError({ statusCode: 400, message: 'A content slug is required' })
  }

  const section = findContentSection(slug)

  if (!section) {
    throw createError({ statusCode: 404, message: `No content section named "${slug}"` })
  }

  return {
    section: renderContentSection(section),
    renderedAt: new Date().toISOString(),
  }
})
