import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ref, readonly } from 'vue'

// useToast uses module-level Vue refs — stub ref and readonly so the shared
// singleton works correctly in the node test environment.
vi.stubGlobal('ref', ref)
vi.stubGlobal('readonly', readonly)

import { useToast } from '../../../composables/useToast'

// Helper to drain all pending toasts between tests.
function clearAllToasts() {
  const { toasts, removeToast } = useToast()
  const ids = (toasts.value as { id: string }[]).map((t) => t.id)
  ids.forEach((id) => removeToast(id))
}

describe('useToast', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    clearAllToasts()
  })

  afterEach(() => {
    clearAllToasts()
    vi.useRealTimers()
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
      const { addToast } = useToast()
      const id = addToast({ message: 'hello' })
      expect(typeof id).toBe('string')
      expect(id.length).toBeGreaterThan(0)
    })

    it('adds the toast to the toasts array', () => {
      const { addToast, toasts } = useToast()
      addToast({ message: 'hello' })
      expect(toasts.value).toHaveLength(1)
      expect(toasts.value[0]?.message).toBe('hello')
    })

    it('defaults type to info when not provided', () => {
      const { addToast, toasts } = useToast()
      addToast({ message: 'default type' })
      expect(toasts.value[0]?.type).toBe('info')
    })

    it('defaults duration to 4000 when not provided', () => {
      const { addToast, toasts } = useToast()
      addToast({ message: 'default duration' })
      expect(toasts.value[0]?.duration).toBe(4000)
    })

    it('respects an explicit type', () => {
      const { addToast, toasts } = useToast()
      addToast({ type: 'success', message: 'done' })
      expect(toasts.value[0]?.type).toBe('success')
    })

    it('respects an explicit duration', () => {
      const { addToast, toasts } = useToast()
      addToast({ message: 'timed', duration: 2000 })
      expect(toasts.value[0]?.duration).toBe(2000)
    })

    it('assigns unique ids to each toast', () => {
      const { addToast, toasts } = useToast()
      addToast({ message: 'first' })
      addToast({ message: 'second' })
      const ids = (toasts.value as { id: string }[]).map((t) => t.id)
      expect(new Set(ids).size).toBe(2)
    })

    it('auto-removes the toast after its duration elapses', () => {
      const { addToast, toasts } = useToast()
      addToast({ message: 'ephemeral', duration: 1000 })
      expect(toasts.value).toHaveLength(1)
      vi.advanceTimersByTime(1000)
      expect(toasts.value).toHaveLength(0)
    })

    it('does not auto-remove when duration is 0', () => {
      const { addToast, toasts } = useToast()
      addToast({ message: 'persistent', duration: 0 })
      vi.advanceTimersByTime(60_000)
      expect(toasts.value).toHaveLength(1)
    })

    it('does not remove other toasts when one auto-expires', () => {
      const { addToast, toasts } = useToast()
      addToast({ message: 'short', duration: 500 })
      addToast({ message: 'long', duration: 5000 })
      vi.advanceTimersByTime(500)
      expect(toasts.value).toHaveLength(1)
      expect(toasts.value[0]?.message).toBe('long')
    })
  })

  describe('removeToast()', () => {
    it('removes the toast with the given id', () => {
      const { addToast, removeToast, toasts } = useToast()
      const id = addToast({ message: 'to remove' })
      removeToast(id)
      expect(toasts.value).toHaveLength(0)
    })

    it('is a no-op when the id does not exist', () => {
      const { addToast, removeToast, toasts } = useToast()
      addToast({ message: 'keep me' })
      expect(() => removeToast('nonexistent-id')).not.toThrow()
      expect(toasts.value).toHaveLength(1)
    })

    it('removes only the toast with the matching id', () => {
      const { addToast, removeToast, toasts } = useToast()
      addToast({ message: 'first' })
      const idToRemove = addToast({ message: 'second' })
      addToast({ message: 'third' })
      removeToast(idToRemove)
      expect(toasts.value).toHaveLength(2)
      const messages = (toasts.value as { message: string }[]).map((t) => t.message)
      expect(messages).toEqual(['first', 'third'])
    })
  })

  describe('success()', () => {
    it('adds a toast with type success', () => {
      const { success, toasts } = useToast()
      success('It worked!')
      expect(toasts.value[0]?.type).toBe('success')
      expect(toasts.value[0]?.message).toBe('It worked!')
    })

    it('passes an explicit duration through', () => {
      const { success, toasts } = useToast()
      success('quick', 1500)
      expect(toasts.value[0]?.duration).toBe(1500)
    })

    it('defaults duration to 4000', () => {
      const { success, toasts } = useToast()
      success('default')
      expect(toasts.value[0]?.duration).toBe(4000)
    })
  })

  describe('error()', () => {
    it('adds a toast with type error', () => {
      const { error, toasts } = useToast()
      error('Something broke')
      expect(toasts.value[0]?.type).toBe('error')
      expect(toasts.value[0]?.message).toBe('Something broke')
    })
  })

  describe('warning()', () => {
    it('adds a toast with type warning', () => {
      const { warning, toasts } = useToast()
      warning('Careful!')
      expect(toasts.value[0]?.type).toBe('warning')
      expect(toasts.value[0]?.message).toBe('Careful!')
    })
  })

  describe('info()', () => {
    it('adds a toast with type info', () => {
      const { info, toasts } = useToast()
      info('FYI')
      expect(toasts.value[0]?.type).toBe('info')
      expect(toasts.value[0]?.message).toBe('FYI')
    })
  })

  describe('shared singleton state', () => {
    it('toasts list is shared across multiple useToast() calls', () => {
      const a = useToast()
      const b = useToast()
      a.addToast({ message: 'from a' })
      expect(b.toasts.value).toHaveLength(1)
    })

    it('removeToast from one instance removes from all', () => {
      const a = useToast()
      const b = useToast()
      const id = a.addToast({ message: 'shared' })
      b.removeToast(id)
      expect(a.toasts.value).toHaveLength(0)
    })
  })
})
