import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { effectScope, onScopeDispose, ref, watchSyncEffect } from 'vue'

import { useScopedEffects } from '../../../composables/useScopedEffects'

describe('useScopedEffects', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('run', () => {
    it('returns whatever the setup returned', () => {
      const scoped = useScopedEffects()

      const state = scoped.run(() => ref('inside'))

      expect(state.value).toBe('inside')
    })

    it('reports no active group until the first run', () => {
      const scoped = useScopedEffects()

      expect(scoped.isActive.value).toBe(false)
      expect(scoped.generation.value).toBe(0)

      scoped.run(() => undefined)

      expect(scoped.isActive.value).toBe(true)
      expect(scoped.generation.value).toBe(1)
    })

    it('increments the generation on every run', () => {
      const scoped = useScopedEffects()

      scoped.run(() => undefined)
      scoped.run(() => undefined)
      scoped.run(() => undefined)

      expect(scoped.generation.value).toBe(3)
    })

    it('keeps ownership of a half-built group when setup throws', () => {
      const scoped = useScopedEffects()
      const source = ref(0)
      const seen: number[] = []

      expect(() =>
        scoped.run(() => {
          watchSyncEffect(() => seen.push(source.value))
          throw new Error('setup blew up')
        }),
      ).toThrow('setup blew up')

      // The watcher created before the throw is still owned by the group, so
      // stopping the group collects it rather than leaking it.
      source.value = 1
      expect(seen).toEqual([0, 1])

      scoped.stop()
      source.value = 2
      expect(seen).toEqual([0, 1])
    })
  })

  describe('grouped teardown', () => {
    it('stops the previous group before starting the next', () => {
      const scoped = useScopedEffects()
      const source = ref(0)
      const first: number[] = []
      const second: number[] = []

      scoped.run(() => watchSyncEffect(() => first.push(source.value)))
      source.value = 1
      expect(first).toEqual([0, 1])

      scoped.run(() => watchSyncEffect(() => second.push(source.value)))
      source.value = 2

      expect(first).toEqual([0, 1])
      expect(second).toEqual([1, 2])
    })

    it('stops every effect in a group, not just the last one', () => {
      const scoped = useScopedEffects()
      const source = ref(0)
      const a: number[] = []
      const b: number[] = []

      scoped.run(() => {
        watchSyncEffect(() => a.push(source.value))
        watchSyncEffect(() => b.push(source.value))
      })

      scoped.stop()
      source.value = 1

      expect(a).toEqual([0])
      expect(b).toEqual([0])
    })

    it('runs onScopeDispose cleanup registered inside the group', () => {
      const scoped = useScopedEffects()
      const tick = vi.fn()

      scoped.run(() => {
        const id = setInterval(tick, 1_000)
        onScopeDispose(() => clearInterval(id))
      })

      vi.advanceTimersByTime(2_000)
      expect(tick).toHaveBeenCalledTimes(2)

      scoped.run(() => undefined)
      vi.advanceTimersByTime(5_000)

      expect(tick).toHaveBeenCalledTimes(2)
    })
  })

  describe('stop', () => {
    it('marks the group inactive without touching the generation', () => {
      const scoped = useScopedEffects()

      scoped.run(() => undefined)
      scoped.stop()

      expect(scoped.isActive.value).toBe(false)
      expect(scoped.generation.value).toBe(1)
    })

    it('is idempotent, and safe before any run', () => {
      const scoped = useScopedEffects()

      expect(() => scoped.stop()).not.toThrow()

      scoped.run(() => undefined)
      scoped.stop()

      expect(() => scoped.stop()).not.toThrow()
      expect(scoped.isActive.value).toBe(false)
    })
  })

  describe('owner scope', () => {
    it('disposes the current group when the owning scope is stopped', () => {
      const owner = effectScope()
      const source = ref(0)
      const seen: number[] = []
      const cleanup = vi.fn()

      owner.run(() => {
        const scoped = useScopedEffects()
        scoped.run(() => {
          watchSyncEffect(() => seen.push(source.value))
          onScopeDispose(cleanup)
        })
      })

      source.value = 1
      expect(seen).toEqual([0, 1])

      owner.stop()
      source.value = 2

      expect(seen).toEqual([0, 1])
      expect(cleanup).toHaveBeenCalledTimes(1)
    })

    it('leaves teardown to the caller when created outside any scope', () => {
      const source = ref(0)
      const seen: number[] = []

      const scoped = useScopedEffects()
      scoped.run(() => watchSyncEffect(() => seen.push(source.value)))

      source.value = 1
      expect(seen).toEqual([0, 1])

      scoped.stop()
      source.value = 2
      expect(seen).toEqual([0, 1])
    })
  })
})
