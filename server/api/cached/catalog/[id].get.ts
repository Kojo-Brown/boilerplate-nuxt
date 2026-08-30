import type { H3Event } from 'h3'

import type { CatalogItem } from '~/server/api/cached/catalog.get'
import { defineCachedApiHandler } from '~/server/utils/cached-route'

/**
 * A cached, tagged item read — the half of the demo that shows why tags are
 * worth the bookkeeping.
 *
 * This route carries two tags. `catalog:<id>` is the narrow one: editing item 4
 * invalidates `catalog:4` and drops exactly that entry, leaving the other items
 * cached. `catalog` is the broad one, shared with the list route, so a change
 * that reshapes the catalog drops the list pages *and* every item in one call.
 *
 * Neither is possible with `maxAge` alone. That is the trade tags buy: two
 * storage writes on a cache miss, in exchange for invalidation that follows the
 * shape of the data instead of the clock.
 */
export interface CatalogItemResponse {
  item: CatalogItem
  renderedAt: string
  tags: string[]
  note: string
}

const TOTAL_ITEMS = 9

export default defineCachedApiHandler(
  {
    name: 'catalog-item',
    maxAge: 60,
    key: (event) => [readId(event)],
    tags: (event) => ['catalog', `catalog:${readId(event)}`],
  },
  (event): CatalogItemResponse => {
    const id = readId(event)

    return {
      item: { id, name: `Item ${id}`, priceCents: 1000 + Number(id) * 250 },
      renderedAt: new Date().toISOString(),
      tags: ['catalog', `catalog:${id}`],
      note: `Cached 60s. Invalidate "catalog:${id}" to drop this entry alone.`,
    }
  },
)

/**
 * The item id, rejected unless it names an item that exists.
 *
 * The 404 is what stops an unknown id becoming a cache entry: without it every
 * `/api/cached/catalog/<anything>` would render, be keyed and be stored, and the
 * key space of this route would be whatever callers typed. Nitro would not cache
 * the error response — its `validate` drops a status ≥ 400 — but the check has
 * to be here, before the render, rather than relying on that.
 */
function readId(event: H3Event): string {
  const id = getRouterParam(event, 'id') ?? ''

  if (!/^\d+$/.test(id) || Number(id) < 1 || Number(id) > TOTAL_ITEMS) {
    throw createError({ statusCode: 404, message: `No catalog item "${id}"` })
  }

  return id
}
