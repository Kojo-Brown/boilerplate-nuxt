import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { computed, effectScope, onScopeDispose, ref, watchSyncEffect } from 'vue'

import { createSharedComposable } from '../../../utils/sharedComposable'

/**
 * Stands in for a mounted component: an active scope that subscriptions can be
 * registered against and that can be disposed on demand.
 */
function mountConsumer<T>(use: () => T): { value: T; unmount: () => void } {
  const scope = effectScope()
  // A fresh scope always runs its callback, so the assertion is safe here.
  const value = scope.run(use) as T
  return { value, unmount: () => scope.stop() }
}

describe('createSharedComposable', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('sharing', () => {
    it('runs the factory once for any number of consumers', () => {
      const factory = vi.fn(() => ref(0))
      const useShared = createSharedComposable(factory)

      mountConsumer(useShared)
      mountConsumer(useShared)
      mountConsumer(useShared)

      expect(factory).toHaveBeenCalledTimes(1)
    })

    it('hands every consumer the identical value', () => {
      const useShared = createSharedComposable(() => ({ count: ref(0) }))

      const a = mountConsumer(useShared)
      const b = mountConsumer(useShared)

      expect(a.value).toBe(b.value)

      a.value.count.value = 7
      expect(b.value.count.value).toBe(7)
    })

    it('works outside any scope, without taking out a subscription', () => {
      const useShared = createSharedComposable(() => ref('shared'))

      const value = useShared()

      expect(value.value).toBe('shared')
      expect(useShared.isActive()).toBe(true)
      expect(useShared.consumers()).toBe(0)
    })
  })

  describe('reference counting', () => {
    it('counts one subscription per consuming scope', () => {
      const useShared = createSharedComposable(() => ref(0))

      expect(useShared.consumers()).toBe(0)

      const a = mountConsumer(useShared)
      expect(useShared.consumers()).toBe(1)

      const b = mountConsumer(useShared)
      expect(useShared.consumers()).toBe(2)

      a.unmount()
      expect(useShared.consumers()).toBe(1)

      b.unmount()
      expect(useShared.consumers()).toBe(0)
    })

    it('counts a scope that subscribes twice as two consumers', () => {
      const factory = vi.fn(() => ref(0))
      const useShared = createSharedComposable(factory)

      const scope = effectScope()
      scope.run(() => {
        useShared()
        useShared()
      })

      expect(factory).toHaveBeenCalledTimes(1)
      expect(useShared.consumers()).toBe(2)

      scope.stop()
      expect(useShared.isActive()).toBe(false)
    })

    it('keeps the instance alive while any consumer remains', () => {
      const useShared = createSharedComposable(() => ref(0))

      const a = mountConsumer(useShared)
      const b = mountConsumer(useShared)

      a.unmount()

      expect(useShared.isActive()).toBe(true)
      b.value.value = 3
      expect(b.value.value).toBe(3)
    })

    it('disposes when the last consumer leaves', () => {
      const useShared = createSharedComposable(() => ref(0))

      const a = mountConsumer(useShared)
      a.unmount()

      expect(useShared.isActive()).toBe(false)
      expect(useShared.consumers()).toBe(0)
    })

    it('builds a fresh instance after teardown', () => {
      const factory = vi.fn(() => ref(0))
      const useShared = createSharedComposable(factory)

      const first = mountConsumer(useShared)
      first.value.value = 42
      first.unmount()

      const second = mountConsumer(useShared)

      expect(factory).toHaveBeenCalledTimes(2)
      expect(second.value).not.toBe(first.value)
      expect(second.value.value).toBe(0)
    })
  })

  describe('grouped teardown', () => {
    it('stops effects the factory created when the last consumer leaves', () => {
      const source = ref(0)
      const seen: number[] = []

      const useShared = createSharedComposable(() => {
        watchSyncEffect(() => seen.push(source.value))
        return computed(() => source.value * 2)
      })

      const consumer = mountConsumer(useShared)
      source.value = 1
      expect(seen).toEqual([0, 1])

      consumer.unmount()
      source.value = 2

      expect(seen).toEqual([0, 1])
    })

    it('keeps the factory effects running while a second consumer holds on', () => {
      const source = ref(0)
      const seen: number[] = []

      const useShared = createSharedComposable(() => {
        watchSyncEffect(() => seen.push(source.value))
        return ref('state')
      })

      const a = mountConsumer(useShared)
      const b = mountConsumer(useShared)

      a.unmount()
      source.value = 1

      // The effect belongs to the shared scope, not to whichever consumer
      // happened to create it first.
      expect(seen).toEqual([0, 1])

      b.unmount()
      source.value = 2
      expect(seen).toEqual([0, 1])
    })

    it('runs onScopeDispose cleanup registered by the factory', () => {
      const tick = vi.fn()

      const useShared = createSharedComposable(() => {
        const id = setInterval(tick, 1_000)
        onScopeDispose(() => clearInterval(id))
        return ref(0)
      })

      const consumer = mountConsumer(useShared)
      vi.advanceTimersByTime(2_000)
      expect(tick).toHaveBeenCalledTimes(2)

      consumer.unmount()
      vi.advanceTimersByTime(5_000)

      expect(tick).toHaveBeenCalledTimes(2)
    })
  })

  describe('explicit dispose', () => {
    it('tears down even while consumers are subscribed', () => {
      const useShared = createSharedComposable(() => ref(0))
      mountConsumer(useShared)

      useShared.dispose()

      expect(useShared.isActive()).toBe(false)
      expect(useShared.consumers()).toBe(0)
    })

    it('is a no-op when nothing is active', () => {
      const useShared = createSharedComposable(() => ref(0))

      expect(() => useShared.dispose()).not.toThrow()
      expect(useShared.isActive()).toBe(false)
    })

    it('leaves stale subscriptions unable to tear down the replacement', () => {
      const useShared = createSharedComposable(() => ref(0))

      const stale = mountConsumer(useShared)
      useShared.dispose()

      // A new instance, subscribed to by someone else.
      const fresh = mountConsumer(useShared)
      expect(useShared.consumers()).toBe(1)

      // The stale consumer's release callback fires now, against an instance
      // that is already gone. It must not touch the live one.
      stale.unmount()

      expect(useShared.isActive()).toBe(true)
      expect(useShared.consumers()).toBe(1)

      fresh.unmount()
      expect(useShared.isActive()).toBe(false)
    })
  })
})
