import type { H3Event } from 'h3'

import { defineCachedApiHandler } from '~/server/utils/cached-route'

/**
 * A cached, tagged, paginated read — the list half of the demo.
 *
 * Everything about the caching is in the options: 30 seconds fresh, stale served
 * while a background render refreshes it, one entry per page, all of them tagged
 * `catalog`. The handler below is an ordinary handler and knows nothing about
 * any of it, the same separation the route-rules demo makes.
 *
 * What makes it observable: `renderedAt` and `renders` come from the render, not
 * the request. Call it repeatedly and both freeze — that is the cache. Call
 * `POST /api/cached/invalidate` with `{"tags":["catalog"]}` and the next call
 * moves them, without waiting out the 30 seconds. That second sentence is the
 * thing Nitro cannot do on its own, and the reason this route exists.
 *
 * The data is synthetic, generated per render, so the demo needs no database —
 * see `server/api/todos/` for the real thing.
 */
export interface CatalogItem {
  id: string
  name: string
  priceCents: number
}

export interface CatalogPage {
  items: CatalogItem[]
  page: number
  pageSize: number
  total: number
  /** When this body was rendered. Frozen for as long as it is cached. */
  renderedAt: string
  /** How many times the handler has run in this process since it started. */
  renders: number
  note: string
}

const PAGE_SIZE = 3
const TOTAL_ITEMS = 9

let renders = 0

export default defineCachedApiHandler(
  {
    name: 'catalog',
    maxAge: 30,
    staleMaxAge: 60,
    // One entry per page. The page number is part of the key, so invalidating
    // `catalog` drops every page and nothing else.
    key: (event) => [String(readPage(event))],
    tags: ['catalog'],
  },
  (event): CatalogPage => {
    renders++

    const page = readPage(event)
    const offset = (page - 1) * PAGE_SIZE

    return {
      items: Array.from({ length: Math.min(PAGE_SIZE, TOTAL_ITEMS - offset) }, (_, index) => {
        const id = String(offset + index + 1)
        return { id, name: `Item ${id}`, priceCents: 1000 + Number(id) * 250 }
      }),
      page,
      pageSize: PAGE_SIZE,
      total: TOTAL_ITEMS,
      renderedAt: new Date().toISOString(),
      renders,
      note: 'Cached 30s (stale up to 60s more), tagged "catalog".',
    }
  },
)

/**
 * The page number, clamped to a page that exists.
 *
 * Clamping is what keeps the key set finite. An unclamped `?page=` would mint a
 * cache entry per value a caller invents, which is a cache-filling request away
 * from being a memory problem — the reason the same clamp is in
 * `server/api/todos/index.get.ts`, and doubly the reason here, where the value
 * is part of a storage key.
 */
function readPage(event: H3Event): number {
  const raw = Number(getQuery(event)['page'] ?? 1)
  if (!Number.isFinite(raw)) return 1
  return Math.min(Math.ceil(TOTAL_ITEMS / PAGE_SIZE), Math.max(1, Math.floor(raw)))
}
