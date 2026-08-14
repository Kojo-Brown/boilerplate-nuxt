import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { computed, watchSyncEffect } from 'vue'

import { useDebouncedRef } from '../../../composables/useDebouncedRef'

describe('useDebouncedRef', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('holds the initial value without deferring it', () => {
    const query = useDebouncedRef('start')

    expect(query.value).toBe('start')
    expect(query.pending.value).toBe(false)
  })

  it('collapses a burst of keystrokes into one published value', () => {
    const query = useDebouncedRef('', 300)
    const searches: string[] = []
    watchSyncEffect(() => searches.push(query.value))

    for (const text of ['n', 'nu', 'nux', 'nuxt']) {
      query.value = text
      vi.advanceTimersByTime(50)
    }

    expect(searches).toEqual([''])

    vi.advanceTimersByTime(300)

    expect(searches).toEqual(['', 'nuxt'])
  })

  it('defaults to a 300 ms delay', () => {
    const query = useDebouncedRef('')

    query.value = 'a'
    vi.advanceTimersByTime(299)
    expect(query.value).toBe('')

    vi.advanceTimersByTime(1)
    expect(query.value).toBe('a')
  })

  it('feeds derived state only the settled value', () => {
    const query = useDebouncedRef('', 100)
    const slug = computed(() => query.value.trim().toLowerCase().replace(/\s+/g, '-'))

    query.value = '  Deferred Refs  '
    expect(slug.value).toBe('')

    vi.advanceTimersByTime(100)
    expect(slug.value).toBe('deferred-refs')
  })

  it('exposes the uncommitted write through draft and pending', () => {
    const query = useDebouncedRef('', 100)
    const { draft, pending } = query

    query.value = 'half-typed'

    expect(draft.value).toBe('half-typed')
    expect(pending.value).toBe(true)

    vi.advanceTimersByTime(100)

    expect(pending.value).toBe(false)
  })

  it('publishes immediately on flush, as a submit handler would', () => {
    const query = useDebouncedRef('', 5_000)

    query.value = 'urgent'
    query.flush()

    expect(query.value).toBe('urgent')
    expect(query.pending.value).toBe(false)
  })

  it('abandons the deferred write on cancel', () => {
    const query = useDebouncedRef('keep', 100)

    query.value = 'discard'
    query.cancel()
    vi.advanceTimersByTime(1_000)

    expect(query.value).toBe('keep')
    expect(query.draft.value).toBe('keep')
  })

  it('bounds the wait with maxWait when the writes never stop', () => {
    const query = useDebouncedRef('', 200, { maxWait: 500 })
    const searches: string[] = []
    watchSyncEffect(() => searches.push(query.value))

    // 100 ms apart forever: the 200 ms quiet period never arrives.
    for (let i = 1; i <= 8; i += 1) {
      query.value = `q${i}`
      vi.advanceTimersByTime(100)
    }

    expect(searches).toEqual(['', 'q5'])
  })

  it('publishes the first write of a burst with leading', () => {
    const query = useDebouncedRef('', 100, { leading: true })
    const searches: string[] = []
    watchSyncEffect(() => searches.push(query.value))

    query.value = 'a'
    query.value = 'ab'
    expect(searches).toEqual(['', 'a'])

    vi.advanceTimersByTime(100)
    expect(searches).toEqual(['', 'a', 'ab'])
  })

  it('works with a non-primitive value', () => {
    const filters = useDebouncedRef<{ tags: string[] }>({ tags: [] }, 100)
    const next = { tags: ['vue', 'nuxt'] }

    filters.value = next
    expect(filters.value.tags).toEqual([])

    vi.advanceTimersByTime(100)
    expect(filters.value).toBe(next)
  })
})
