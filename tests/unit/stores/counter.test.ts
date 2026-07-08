import { describe, it, expect, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useCounterStore } from '../../../stores/counter'

describe('useCounterStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('has default state', () => {
    const store = useCounterStore()
    expect(store.count).toBe(0)
    expect(store.lastUpdated).toBeNull()
  })

  it('increments count and sets lastUpdated', () => {
    const store = useCounterStore()
    store.increment()
    expect(store.count).toBe(1)
    expect(store.lastUpdated).not.toBeNull()
  })

  it('decrements count', () => {
    const store = useCounterStore()
    store.setCount(5)
    store.decrement()
    expect(store.count).toBe(4)
  })

  it('resets to zero and clears lastUpdated', () => {
    const store = useCounterStore()
    store.setCount(42)
    store.reset()
    expect(store.count).toBe(0)
    expect(store.lastUpdated).toBeNull()
  })

  it('sets count directly', () => {
    const store = useCounterStore()
    store.setCount(99)
    expect(store.count).toBe(99)
    expect(store.lastUpdated).not.toBeNull()
  })

  it('doubled getter returns twice the count', () => {
    const store = useCounterStore()
    store.setCount(5)
    expect(store.doubled).toBe(10)
  })

  it('doubled is 0 at initial state', () => {
    const store = useCounterStore()
    expect(store.doubled).toBe(0)
  })

  it('isPositive is true when count > 0', () => {
    const store = useCounterStore()
    store.setCount(1)
    expect(store.isPositive).toBe(true)
  })

  it('isPositive is false when count is 0', () => {
    const store = useCounterStore()
    expect(store.isPositive).toBe(false)
  })

  it('isPositive is false when count is negative', () => {
    const store = useCounterStore()
    store.setCount(-3)
    expect(store.isPositive).toBe(false)
  })

  it('multiple increments accumulate', () => {
    const store = useCounterStore()
    store.increment()
    store.increment()
    store.increment()
    expect(store.count).toBe(3)
  })
})
