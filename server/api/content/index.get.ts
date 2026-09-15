import type { ContentSectionSummary } from '~/server/utils/content'
import { listContentSections } from '~/server/utils/content'

/**
 * The section index — what `components/islands/ContentIndex.vue` renders.
 *
 * Summaries only. The index is a navigation aid, so sending every body with it
 * would ship the whole page's content twice: once here and once through the
 * per-section islands that actually display it.
 */
export interface ContentIndexResponse {
  readonly sections: ContentSectionSummary[]
  /**
   * When this response was produced. Visible in the demo so a cached island and
   * a fresh render can be told apart.
   */
  readonly renderedAt: string
}

export default defineEventHandler((): ContentIndexResponse => {
  return {
    sections: listContentSections(),
    renderedAt: new Date().toISOString(),
  }
})
