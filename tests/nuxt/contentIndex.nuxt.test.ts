import { mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import { describe, expect, it, vi } from 'vitest'

import ContentIndex from '~/components/islands/ContentIndex.vue'
import type { ContentIndexResponse } from '~/server/api/content/index.get'
import type { ContentSectionSummary } from '~/server/utils/content'

/**
 * The async case, and the reason the mount helper is called
 * `mountSuspended`: `ContentIndex` awaits `$fetch('/api/content')` at the top
 * level of its `setup()`, so the component is a Suspense boundary and
 * `@vue/test-utils`' own `mount` would hand back a wrapper holding the fallback.
 * `mountSuspended` resolves the boundary first, which is why every assertion
 * below can read real markup off the first render.
 *
 * `registerEndpoint` is the other half: `$fetch` inside the Nuxt environment is
 * routed to an h3 app the test owns, so the route is answered without a server,
 * a database, or an interception of the global `fetch`. The fixture is obviously
 * fake, which also makes the assertions readable — "On this page" lists what the
 * endpoint returned, in the order it returned it.
 */
const sections: ContentSectionSummary[] = [
  {
    slug: 'what-islands-are',
    title: 'What islands are',
    summary: 'Server-rendered HTML with no client component.',
    updatedAt: '2026-01-01',
  },
  {
    slug: 'when-not-to',
    title: 'When not to use one',
    summary: 'Anything that has to respond to a click.',
    updatedAt: '2026-01-02',
  },
]

const renderedAt = '2026-01-03T04:05:06.000Z'

const handler = vi.fn((): ContentIndexResponse => ({
  sections,
  renderedAt,
}))

registerEndpoint('/api/content', handler)

describe('ContentIndex', () => {
  it('renders one link per section, in the order the endpoint returned them', async () => {
    const index = await mountSuspended(ContentIndex)
    const links = index.findAll('a')

    expect(links.map((link) => link.text())).toEqual(['What islands are', 'When not to use one'])
    // In-page anchors rather than `<NuxtLink>`s, because island markup is inert:
    // nothing would ever bind a click handler to a link rendered here.
    expect(links.map((link) => link.attributes('href'))).toEqual([
      '#what-islands-are',
      '#when-not-to',
    ])
  })

  it('renders each section summary with its link', async () => {
    const index = await mountSuspended(ContentIndex)

    expect(index.text()).toContain('Server-rendered HTML with no client component.')
    expect(index.text()).toContain('Anything that has to respond to a click.')
  })

  it('names the navigation landmark it renders', async () => {
    const index = await mountSuspended(ContentIndex)

    // Two or more `<nav>`s in a document need distinguishing names; this one is
    // one of several on the page it is an island of.
    expect(index.get('nav').attributes('aria-label')).toBe('Content sections')
  })

  it('shows when the response was produced', async () => {
    const index = await mountSuspended(ContentIndex)

    // The demo's whole point: the timestamp is the endpoint's, so a cached
    // island and a fresh render can be told apart on the page.
    expect(index.text()).toContain(renderedAt)
  })

  it('fetches once per mount', async () => {
    handler.mockClear()
    await mountSuspended(ContentIndex)

    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('renders an empty list rather than failing when there are no sections', async () => {
    handler.mockReturnValueOnce({ sections: [], renderedAt })
    const index = await mountSuspended(ContentIndex)

    expect(index.findAll('a')).toHaveLength(0)
    expect(index.get('h2').text()).toBe('On this page')
  })
})
