import { describe, it, expect } from 'vitest'

import { cacheInvalidationSchema } from '~/server/utils/cache-schemas'

describe('cacheInvalidationSchema', () => {
  it('accepts the tag shapes this app uses', () => {
    const parsed = cacheInvalidationSchema.safeParse({ tags: ['catalog', 'catalog:42', 'user_7'] })
    expect(parsed.success).toBe(true)
  })

  it('requires at least one tag', () => {
    const parsed = cacheInvalidationSchema.safeParse({ tags: [] })
    expect(parsed.success).toBe(false)
    expect(parsed.error?.issues[0]?.message).toBe('At least one tag is required')
  })

  it('rejects a body with no tags at all', () => {
    expect(cacheInvalidationSchema.safeParse({}).success).toBe(false)
    expect(cacheInvalidationSchema.safeParse({ tags: 'catalog' }).success).toBe(false)
  })

  it.each(['', ' catalog', 'Catalog', '42', 'catalog/42', 'catalog.42', 'catalog%'])(
    'rejects %j, which is not a tag this app can produce',
    (tag) => {
      expect(cacheInvalidationSchema.safeParse({ tags: [tag] }).success).toBe(false)
    },
  )

  it('caps a tag length, because a tag becomes part of a storage key', () => {
    expect(cacheInvalidationSchema.safeParse({ tags: ['a'.repeat(128)] }).success).toBe(true)
    expect(cacheInvalidationSchema.safeParse({ tags: ['a'.repeat(129)] }).success).toBe(false)
  })

  it('caps how many tags one request may sweep', () => {
    const tags = Array.from({ length: 51 }, (_, index) => `tag-${index}`)
    expect(cacheInvalidationSchema.safeParse({ tags: tags.slice(0, 50) }).success).toBe(true)
    expect(cacheInvalidationSchema.safeParse({ tags }).success).toBe(false)
  })
})
