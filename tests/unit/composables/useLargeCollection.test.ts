import { describe, it, expect, vi } from 'vitest'
import { isReactive, isShallow, reactive, watchSyncEffect } from 'vue'

import { useLargeCollection } from '../../../composables/useLargeCollection'

interface Row {
  id: string
  label: string
  hits: number
}

function row(id: string, hits = 0): Row {
  return { id, label: `row-${id}`, hits }
}

function rows(count: number, prefix = 'r'): Row[] {
  return Array.from({ length: count }, (_, i) => row(`${prefix}${i}`, i))
}

function collection(initial?: readonly Row[]) {
  return useLargeCollection<Row>({
    key: (r) => r.id,
    ...(initial ? { initial } : {}),
  })
}

/**
 * Counts how many times an effect depending on `items` re-runs. Synchronous
 * flush so a commit is observable without awaiting `nextTick`.
 */
function trackRenders(read: () => unknown) {
  const spy = vi.fn()
  const stop = watchSyncEffect(() => {
    read()
    spy()
  })
  return { spy, stop }
}

describe('useLargeCollection', () => {
  describe('shallowRef storage', () => {
    it('holds rows in a shallow ref', () => {
      const c = collection(rows(3))
      expect(isShallow(c.items)).toBe(true)
    })

    it('does not proxy the array or the rows it contains', () => {
      const c = collection(rows(3))

      expect(isReactive(c.items.value)).toBe(false)
      expect(isReactive(c.items.value[0])).toBe(false)
    })

    it('hands back the same row object that was put in', () => {
      const seed = row('a')
      const c = collection([seed])

      // A deep `ref` would return a Proxy here, not the original object.
      expect(c.items.value[0]).toBe(seed)
      expect(c.find('a')).toBe(seed)
    })

    it('copies the seed array instead of aliasing it', () => {
      const seed = rows(2)
      const c = collection(seed)

      seed.push(row('extra'))

      expect(c.size.value).toBe(2)
    })

    it('starts empty when no initial rows are given', () => {
      const c = collection()

      expect(c.size.value).toBe(0)
      expect(c.items.value).toEqual([])
    })

    it('keeps state per call so SSR requests cannot share it', () => {
      const a = collection(rows(2, 'a'))
      const b = collection(rows(5, 'b'))

      a.append([row('a-extra')])

      expect(a.size.value).toBe(3)
      expect(b.size.value).toBe(5)
      expect(b.find('a-extra')).toBeUndefined()
    })
  })

  describe('replaceAll', () => {
    it('swaps the payload and notifies dependants', () => {
      const c = collection(rows(2))
      const { spy, stop } = trackRenders(() => c.items.value)

      c.replaceAll(rows(1000, 'big'))

      expect(spy).toHaveBeenCalledTimes(2) // initial run + one commit
      expect(c.size.value).toBe(1000)
      stop()
    })

    it('installs a fresh array rather than mutating the old one', () => {
      const c = collection(rows(2))
      const before = c.items.value

      c.replaceAll(rows(3, 'next'))

      expect(c.items.value).not.toBe(before)
      expect(before).toHaveLength(2)
    })

    it('rebuilds the index, dropping keys that are gone', () => {
      const c = collection(rows(3, 'old'))
      c.replaceAll(rows(2, 'new'))

      expect(c.find('old0')).toBeUndefined()
      expect(c.find('new1')?.id).toBe('new1')
      expect(c.index.size).toBe(2)
    })

    it('does not alias the array it is handed', () => {
      const c = collection()
      const next = rows(2, 'x')

      c.replaceAll(next)
      next.push(row('sneaky'))

      expect(c.size.value).toBe(2)
      expect(c.find('sneaky')).toBeUndefined()
    })
  })

  describe('append', () => {
    it('grows the existing array in place', () => {
      const c = collection(rows(2))
      const before = c.items.value

      c.append(rows(3, 'more'))

      // Same array object — no reallocation of the rows already held.
      expect(c.items.value).toBe(before)
      expect(c.size.value).toBe(5)
    })

    it('publishes the in-place growth through triggerRef', () => {
      const c = collection(rows(2))
      const { spy, stop } = trackRenders(() => c.size.value)

      c.append([row('added')])

      expect(spy).toHaveBeenCalledTimes(2)
      expect(c.size.value).toBe(3)
      stop()
    })

    it('indexes the appended rows', () => {
      const c = collection()
      c.append([row('a'), row('b')])

      expect(c.find('b')?.label).toBe('row-b')
    })

    it('commits once for a batch, not once per row', () => {
      const c = collection()
      const { spy, stop } = trackRenders(() => c.items.value)

      c.append(rows(500, 'batch'))

      expect(spy).toHaveBeenCalledTimes(2)
      expect(c.revision.value).toBe(1)
      stop()
    })

    it('is a no-op for an empty batch', () => {
      const c = collection(rows(1))
      const { spy, stop } = trackRenders(() => c.items.value)

      c.append([])

      expect(spy).toHaveBeenCalledTimes(1)
      expect(c.revision.value).toBe(0)
      stop()
    })
  })

  describe('triggerRef commit semantics', () => {
    it('leaves an unpublished in-place edit invisible to effects', () => {
      const c = collection(rows(2))
      const { spy, stop } = trackRenders(() => c.items.value)

      // Editing a row behind the collection's back: the rows are plain
      // objects, so nothing observes this.
      const target = c.find('r0')
      if (!target) throw new Error('expected r0 to be indexed')
      target.hits = 99

      expect(spy).toHaveBeenCalledTimes(1)
      expect(c.find('r0')?.hits).toBe(99) // the data did change...

      // ...it just had not been published until a commit happens.
      c.mutate(() => {})
      expect(spy).toHaveBeenCalledTimes(2)
      stop()
    })

    it('recomputes derived state after an in-place splice', () => {
      const c = collection(rows(4))

      c.mutate((live) => {
        live.splice(0, 2)
      })

      expect(c.size.value).toBe(2)
      expect(c.items.value[0]?.id).toBe('r2')
    })

    it('reindexes after the mutator reorders rows', () => {
      const c = collection(rows(3))

      c.mutate((live) => live.reverse())

      expect(c.items.value[0]?.id).toBe('r2')
      expect(c.find('r2')).toBe(c.items.value[0])
    })

    it('reindexes rows the mutator re-keyed', () => {
      const c = collection([row('before')])

      c.mutate((live) => {
        const first = live[0]
        if (first) first.id = 'after'
      })

      expect(c.find('before')).toBeUndefined()
      expect(c.find('after')?.label).toBe('row-before')
    })

    it('increments revision exactly once per commit', () => {
      const c = collection(rows(2))

      expect(c.revision.value).toBe(0)
      c.append([row('a')])
      c.patch('a', { hits: 1 })
      c.mutate(() => {})

      expect(c.revision.value).toBe(3)
    })
  })

  describe('patch', () => {
    it('edits the row in place and commits', () => {
      const c = collection(rows(2))
      const target = c.find('r1')
      const { spy, stop } = trackRenders(() => c.items.value)

      expect(c.patch('r1', { hits: 42 })).toBe(true)

      expect(target?.hits).toBe(42)
      expect(c.items.value[1]).toBe(target) // same object, edited in place
      expect(spy).toHaveBeenCalledTimes(2)
      stop()
    })

    it('re-keys the index when the patch moves the row identity', () => {
      const c = collection([row('old-id')])

      expect(c.patch('old-id', { id: 'new-id' })).toBe(true)

      expect(c.find('old-id')).toBeUndefined()
      expect(c.find('new-id')?.id).toBe('new-id')
      expect(c.index.size).toBe(1)
    })

    it('returns false and commits nothing for an unknown key', () => {
      const c = collection(rows(1))
      const { spy, stop } = trackRenders(() => c.items.value)

      expect(c.patch('missing', { hits: 1 })).toBe(false)

      expect(spy).toHaveBeenCalledTimes(1)
      expect(c.revision.value).toBe(0)
      stop()
    })
  })

  describe('remove', () => {
    it('drops the row from both the array and the index', () => {
      const c = collection(rows(3))

      expect(c.remove('r1')).toBe(true)

      expect(c.size.value).toBe(2)
      expect(c.find('r1')).toBeUndefined()
      expect(c.items.value.map((r) => r.id)).toEqual(['r0', 'r2'])
    })

    it('publishes the removal', () => {
      const c = collection(rows(2))
      const { spy, stop } = trackRenders(() => c.size.value)

      c.remove('r0')

      expect(spy).toHaveBeenCalledTimes(2)
      stop()
    })

    it('returns false for an unknown key', () => {
      const c = collection(rows(1))

      expect(c.remove('nope')).toBe(false)
      expect(c.size.value).toBe(1)
    })
  })

  describe('clear', () => {
    it('empties the collection and the index', () => {
      const c = collection(rows(3))
      const { spy, stop } = trackRenders(() => c.items.value)

      c.clear()

      expect(c.size.value).toBe(0)
      expect(c.index.size).toBe(0)
      expect(c.find('r0')).toBeUndefined()
      expect(spy).toHaveBeenCalledTimes(2)
      stop()
    })

    it('leaves the collection usable afterwards', () => {
      const c = collection(rows(2))
      c.clear()
      c.append([row('fresh')])

      expect(c.size.value).toBe(1)
      expect(c.find('fresh')?.id).toBe('fresh')
    })
  })

  describe('markRaw index', () => {
    it('keeps the index out of the reactivity system', () => {
      const c = collection(rows(3))

      expect(isReactive(c.index)).toBe(false)
    })

    it('is opted out deliberately — an unmarked Map in the same slot is proxied', () => {
      // The index sits on a `reactive` metadata object. Without `markRaw`, this
      // is what it would have become: a collection proxy tracking every get()
      // and firing effects on every set().
      const unmarked = reactive({ index: new Map<string, Row>() })

      expect(isReactive(unmarked.index)).toBe(true)
    })

    it('keeps a stable reference across rebuilds', () => {
      const c = collection(rows(2))
      const index = c.index

      c.replaceAll(rows(3, 'next'))
      c.clear()
      c.append([row('a')])

      expect(c.index).toBe(index)
      expect(index.get('a')?.id).toBe('a')
    })

    it('reads from the index without registering a dependency', () => {
      const c = collection(rows(2))
      const spy = vi.fn()
      const stop = watchSyncEffect(() => {
        c.find('r0')
        spy()
      })

      // Nothing this effect read is reactive, so a later commit must not
      // re-run it.
      c.patch('r1', { hits: 1 })

      expect(spy).toHaveBeenCalledTimes(1)
      stop()
    })
  })

  describe('large payloads', () => {
    it('carries 20k rows without proxying any of them', () => {
      const c = collection()
      c.replaceAll(rows(20_000, 'big'))

      expect(c.size.value).toBe(20_000)
      expect(isReactive(c.items.value[19_999])).toBe(false)
      expect(c.find('big19999')?.hits).toBe(19_999)
    })

    it('commits a bulk in-place edit once', () => {
      const c = collection(rows(20_000, 'big'))
      const { spy, stop } = trackRenders(() => c.items.value)

      c.mutate((live) => {
        for (const r of live) r.hits += 1
      })

      expect(spy).toHaveBeenCalledTimes(2)
      expect(c.find('big0')?.hits).toBe(1)
      stop()
    })
  })
})
