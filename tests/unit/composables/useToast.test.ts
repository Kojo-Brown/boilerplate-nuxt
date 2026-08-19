import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

import { useToast } from '../../../composables/useToast'
import type { ToastScheduler } from '../../../composables/useToast'
import { createFakeNuxtApp, resetFakeNuxtApp, withFakeNuxtApp } from '../../helpers/nuxtApp'

/**
 * A scheduler with a clock the test drives, injected in place of `setTimeout`.
 *
 * The point is not that it is faster than `vi.useFakeTimers()` — it is that
 * `useToast` never reaches for a timer at all. Auto-dismiss is exercised through
 * the same seam production code uses, so the test proves the dependency is
 * genuinely injectable rather than proving that a global can be patched.
 */
function createFakeScheduler() {
  let time = 0
  let queue: { at: number; callback: () => void }[] = []

  const schedule: ToastScheduler = (callback, delayMs) => {
    queue.push({ at: time + delayMs, callback })
  }

  return {
    schedule,
    pending: (): number => queue.length,
    advance(ms: number): void {
      time += ms
      const due = queue.filter((timer) => timer.at <= time).sort((a, b) => a.at - b.at)
      queue = queue.filter((timer) => timer.at > time)
      for (const timer of due) timer.callback()
    },
  }
}

/** Deterministic id inputs, so an assertion can name an id instead of finding it. */
function createFakeIdSource() {
  let tick = 0
  return {
    now: (): number => 1_700_000_000_000 + tick,
    random: (): number => {
      tick += 1
      return tick / 1000
    },
  }
}

function createDeps() {
  return { ...createFakeIdSource(), ...createFakeScheduler() }
}

describe('useToast', () => {
  beforeEach(() => {
    // Every test starts in a fresh Nuxt app, the way every request does.
    resetFakeNuxtApp()
  })

  it('exposes toasts, addToast, removeToast, success, error, warning, and info', () => {
    const toast = useToast()
    expect(toast.toasts).toBeDefined()
    expect(typeof toast.addToast).toBe('function')
    expect(typeof toast.removeToast).toBe('function')
    expect(typeof toast.success).toBe('function')
    expect(typeof toast.error).toBe('function')
    expect(typeof toast.warning).toBe('function')
    expect(typeof toast.info).toBe('function')
  })

  it('starts with an empty toasts list', () => {
    const { toasts } = useToast()
    expect(toasts.value).toHaveLength(0)
  })

  describe('addToast()', () => {
    it('returns a non-empty string id', () => {
      const { addToast } = useToast(createDeps())
      const id = addToast({ message: 'hello' })
      expect(typeof id).toBe('string')
      expect(id.length).toBeGreaterThan(0)
    })

    it('adds the toast to the toasts array', () => {
      const { addToast, toasts } = useToast(createDeps())
      addToast({ message: 'hello' })
      expect(toasts.value).toHaveLength(1)
      expect(toasts.value[0]?.message).toBe('hello')
    })

    it('defaults type to info when not provided', () => {
      const { addToast, toasts } = useToast(createDeps())
      addToast({ message: 'default type' })
      expect(toasts.value[0]?.type).toBe('info')
    })

    it('defaults duration to 4000 when not provided', () => {
      const { addToast, toasts } = useToast(createDeps())
      addToast({ message: 'default duration' })
      expect(toasts.value[0]?.duration).toBe(4000)
    })

    it('respects an explicit type', () => {
      const { addToast, toasts } = useToast(createDeps())
      addToast({ type: 'success', message: 'done' })
      expect(toasts.value[0]?.type).toBe('success')
    })

    it('respects an explicit duration', () => {
      const { addToast, toasts } = useToast(createDeps())
      addToast({ message: 'timed', duration: 2000 })
      expect(toasts.value[0]?.duration).toBe(2000)
    })

    it('assigns unique ids to each toast', () => {
      // Deliberately on the real `Date.now`/`Math.random`: with an injected id
      // source this would only assert that the fake counts.
      const { addToast, toasts } = useToast()
      addToast({ message: 'first' })
      addToast({ message: 'second' })
      const ids = toasts.value.map((t) => t.id)
      expect(new Set(ids).size).toBe(2)
    })

    it('auto-removes the toast after its duration elapses', () => {
      const deps = createDeps()
      const { addToast, toasts } = useToast(deps)
      addToast({ message: 'ephemeral', duration: 1000 })
      expect(toasts.value).toHaveLength(1)
      deps.advance(1000)
      expect(toasts.value).toHaveLength(0)
    })

    it('does not auto-remove when duration is 0', () => {
      const deps = createDeps()
      const { addToast, toasts } = useToast(deps)
      addToast({ message: 'persistent', duration: 0 })
      expect(deps.pending()).toBe(0)
      deps.advance(60_000)
      expect(toasts.value).toHaveLength(1)
    })

    it('does not remove other toasts when one auto-expires', () => {
      const deps = createDeps()
      const { addToast, toasts } = useToast(deps)
      addToast({ message: 'short', duration: 500 })
      addToast({ message: 'long', duration: 5000 })
      deps.advance(500)
      expect(toasts.value).toHaveLength(1)
      expect(toasts.value[0]?.message).toBe('long')
    })

    it('auto-dismiss is a no-op when the toast was already removed by hand', () => {
      const deps = createDeps()
      const { addToast, removeToast, toasts } = useToast(deps)
      const id = addToast({ message: 'dismissed early', duration: 1000 })
      removeToast(id)
      addToast({ message: 'added after', duration: 0 })
      deps.advance(1000)
      expect(toasts.value.map((t) => t.message)).toEqual(['added after'])
    })
  })

  describe('default dependencies', () => {
    beforeEach(() => {
      vi.useFakeTimers()
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    it('schedules auto-dismiss on a real timer when no scheduler is injected', () => {
      const { addToast, toasts } = useToast()
      addToast({ message: 'real timer', duration: 1000 })
      expect(toasts.value).toHaveLength(1)
      vi.advanceTimersByTime(1000)
      expect(toasts.value).toHaveLength(0)
    })

    it('accepts a partial dependency object, defaulting the rest', () => {
      const { schedule, advance } = createFakeScheduler()
      const { addToast, toasts } = useToast({ schedule })
      const id = addToast({ message: 'partial', duration: 1000 })
      // The id came from the real clock and RNG, so only its shape is known.
      expect(id).toMatch(/^\d+-\w+$/)
      // Nothing was handed to `setTimeout`; the injected scheduler owns it.
      vi.advanceTimersByTime(60_000)
      expect(toasts.value).toHaveLength(1)
      advance(1000)
      expect(toasts.value).toHaveLength(0)
    })
  })

  describe('removeToast()', () => {
    it('removes the toast with the given id', () => {
      const { addToast, removeToast, toasts } = useToast(createDeps())
      const id = addToast({ message: 'to remove' })
      removeToast(id)
      expect(toasts.value).toHaveLength(0)
    })

    it('is a no-op when the id does not exist', () => {
      const { addToast, removeToast, toasts } = useToast(createDeps())
      addToast({ message: 'keep me' })
      expect(() => removeToast('nonexistent-id')).not.toThrow()
      expect(toasts.value).toHaveLength(1)
    })

    it('removes only the toast with the matching id', () => {
      const { addToast, removeToast, toasts } = useToast(createDeps())
      addToast({ message: 'first' })
      const idToRemove = addToast({ message: 'second' })
      addToast({ message: 'third' })
      removeToast(idToRemove)
      expect(toasts.value).toHaveLength(2)
      const messages = toasts.value.map((t) => t.message)
      expect(messages).toEqual(['first', 'third'])
    })
  })

  describe('success()', () => {
    it('adds a toast with type success', () => {
      const { success, toasts } = useToast(createDeps())
      success('It worked!')
      expect(toasts.value[0]?.type).toBe('success')
      expect(toasts.value[0]?.message).toBe('It worked!')
    })

    it('passes an explicit duration through', () => {
      const { success, toasts } = useToast(createDeps())
      success('quick', 1500)
      expect(toasts.value[0]?.duration).toBe(1500)
    })

    it('defaults duration to 4000', () => {
      const { success, toasts } = useToast(createDeps())
      success('default')
      expect(toasts.value[0]?.duration).toBe(4000)
    })
  })

  describe('error()', () => {
    it('adds a toast with type error', () => {
      const { error, toasts } = useToast(createDeps())
      error('Something broke')
      expect(toasts.value[0]?.type).toBe('error')
      expect(toasts.value[0]?.message).toBe('Something broke')
    })
  })

  describe('warning()', () => {
    it('adds a toast with type warning', () => {
      const { warning, toasts } = useToast(createDeps())
      warning('Careful!')
      expect(toasts.value[0]?.type).toBe('warning')
      expect(toasts.value[0]?.message).toBe('Careful!')
    })
  })

  describe('info()', () => {
    it('adds a toast with type info', () => {
      const { info, toasts } = useToast(createDeps())
      info('FYI')
      expect(toasts.value[0]?.type).toBe('info')
      expect(toasts.value[0]?.message).toBe('FYI')
    })
  })

  describe('shared state within one app', () => {
    it('toasts list is shared across multiple useToast() calls', () => {
      const a = useToast(createDeps())
      const b = useToast(createDeps())
      a.addToast({ message: 'from a' })
      expect(b.toasts.value).toHaveLength(1)
    })

    it('removeToast from one instance removes from all', () => {
      const a = useToast(createDeps())
      const b = useToast(createDeps())
      const id = a.addToast({ message: 'shared' })
      b.removeToast(id)
      expect(a.toasts.value).toHaveLength(0)
    })
  })

  describe('SSR isolation', () => {
    it('does not leak toasts between two concurrent apps', () => {
      const requestA = createFakeNuxtApp()
      const requestB = createFakeNuxtApp()

      const a = withFakeNuxtApp(requestA, () => useToast(createDeps()))
      const b = withFakeNuxtApp(requestB, () => useToast(createDeps()))

      a.addToast({ message: 'visible to A only' })

      expect(a.toasts.value.map((t) => t.message)).toEqual(['visible to A only'])
      expect(b.toasts.value).toHaveLength(0)
    })

    it('gives a later app an empty list even after an earlier one filled it', () => {
      const firstRequest = createFakeNuxtApp()
      withFakeNuxtApp(firstRequest, () => {
        useToast(createDeps()).addToast({ message: 'from the first request' })
      })

      const secondRequest = createFakeNuxtApp()
      const later = withFakeNuxtApp(secondRequest, () => useToast(createDeps()))

      expect(later.toasts.value).toHaveLength(0)
    })

    it('holds no state in the module: a fresh app starts empty', () => {
      // The regression this guards is a module-scope `const toasts = ref([])`,
      // which survives `resetFakeNuxtApp()` because it never lived on the app.
      useToast(createDeps()).addToast({ message: 'before reset' })
      resetFakeNuxtApp()
      expect(useToast(createDeps()).toasts.value).toHaveLength(0)
    })
  })
})
