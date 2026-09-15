import { describe, it, expect, vi } from 'vitest'

import {
  CONTENT_SECTIONS,
  findContentSection,
  listContentSections,
  renderContentSection,
} from '../../../server/utils/content'

/**
 * The corpus is static, so most of what can break here is the corpus itself: a
 * duplicated slug (which would make one section unreachable), a section that
 * renders to nothing, a summary left empty. Those are the assertions below —
 * they run over every section rather than over a fixture, so adding one to
 * `content.ts` extends the suite without touching this file.
 *
 * The API handlers are exercised directly. `defineEventHandler` is an identity
 * wrapper in tests/setup.ts; `getRouterParam` and `createError` are stubbed per
 * test, because the handlers reach for them as Nitro auto-imports that do not
 * exist in a plain Node process.
 */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

describe('CONTENT_SECTIONS', () => {
  it('is not empty', () => {
    expect(CONTENT_SECTIONS.length).toBeGreaterThan(0)
  })

  it('has a unique slug per section', () => {
    const slugs = CONTENT_SECTIONS.map((section) => section.slug)
    expect(new Set(slugs).size).toBe(slugs.length)
  })

  it.each(CONTENT_SECTIONS.map((section) => [section.slug, section] as const))(
    '%s is well-formed',
    (_slug, section) => {
      // A slug lands in a URL and in an element id, so it is restricted to what
      // is safe in both without encoding.
      expect(section.slug).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/)
      expect(section.title.trim()).not.toBe('')
      expect(section.summary.trim()).not.toBe('')
      expect(section.updatedAt).toMatch(ISO_DATE)
      expect(section.body.trim()).not.toBe('')
    },
  )

  it('is frozen, so a handler cannot mutate the corpus for later requests', () => {
    expect(Object.isFrozen(CONTENT_SECTIONS)).toBe(true)
  })
})

describe('listContentSections', () => {
  it('summarises every section in authored order', () => {
    expect(listContentSections().map((section) => section.slug)).toEqual(
      CONTENT_SECTIONS.map((section) => section.slug),
    )
  })

  it('omits the body, which is the point of a summary', () => {
    for (const summary of listContentSections()) {
      expect(summary).not.toHaveProperty('body')
    }
  })
})

describe('findContentSection', () => {
  it('finds every authored slug', () => {
    for (const section of CONTENT_SECTIONS) {
      expect(findContentSection(section.slug)?.title).toBe(section.title)
    }
  })

  it('returns undefined for an unknown slug', () => {
    expect(findContentSection('no-such-section')).toBeUndefined()
  })

  it('returns undefined rather than an inherited property for a prototype key', () => {
    // A Map, not a plain object, so `constructor` and `__proto__` are misses
    // like anything else — worth pinning, since the lookup key comes from a URL.
    expect(findContentSection('constructor')).toBeUndefined()
    expect(findContentSection('__proto__')).toBeUndefined()
  })
})

describe('renderContentSection', () => {
  it.each(CONTENT_SECTIONS.map((section) => [section.slug, section] as const))(
    '%s renders to HTML and plain text',
    (_slug, section) => {
      const rendered = renderContentSection(section)

      expect(rendered.slug).toBe(section.slug)
      expect(rendered.html).toContain('<p>')
      expect(rendered.plainText.length).toBeGreaterThan(0)
      // The raw markers are gone: the body went through the renderer rather than
      // being passed along verbatim.
      expect(rendered.html).not.toContain('**')
    },
  )

  it('does not carry the authored body into the response', () => {
    const rendered = renderContentSection(CONTENT_SECTIONS[0]!)
    expect(rendered).not.toHaveProperty('body')
  })
})

describe('GET /api/content', () => {
  it('returns every section summary and a timestamp', async () => {
    const { default: handler } = await import('../../../server/api/content/index.get')

    const result = handler({} as Parameters<typeof handler>[0])

    expect(result.sections.map((section) => section.slug)).toEqual(
      CONTENT_SECTIONS.map((section) => section.slug),
    )
    expect(() => new Date(result.renderedAt).toISOString()).not.toThrow()
  })
})

describe('GET /api/content/[slug]', () => {
  async function callHandler(slug: string | undefined) {
    vi.stubGlobal('getRouterParam', () => slug)
    vi.stubGlobal('createError', (input: { statusCode: number; message: string }) => {
      const error = new Error(input.message) as Error & { statusCode: number }
      error.statusCode = input.statusCode
      return error
    })

    const { default: handler } = await import('../../../server/api/content/[slug].get')
    return handler({} as Parameters<typeof handler>[0])
  }

  it('renders the requested section', async () => {
    const first = CONTENT_SECTIONS[0]!
    const result = await callHandler(first.slug)

    expect(result.section.title).toBe(first.title)
    expect(result.section.html).toContain('<p>')
  })

  it('throws 404 for an unknown slug', async () => {
    await expect(callHandler('no-such-section')).rejects.toMatchObject({ statusCode: 404 })
  })

  it('throws 400 when the route parameter is missing', async () => {
    await expect(callHandler(undefined)).rejects.toMatchObject({ statusCode: 400 })
  })
})
