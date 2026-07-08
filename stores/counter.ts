import { defineStore } from 'pinia'

interface CounterState {
  count: number
  lastUpdated: string | null
}

export const useCounterStore = defineStore('counter', {
  state: (): CounterState => ({
    count: 0,
    lastUpdated: null,
  }),
  getters: {
    doubled: (state): number => state.count * 2,
    isPositive: (state): boolean => state.count > 0,
  },
  actions: {
    increment() {
      this.count++
      this.lastUpdated = new Date().toISOString()
    },
    decrement() {
      this.count--
      this.lastUpdated = new Date().toISOString()
    },
    reset() {
      this.count = 0
      this.lastUpdated = null
    },
    setCount(value: number) {
      this.count = value
      this.lastUpdated = new Date().toISOString()
    },
  },
  persist: true,
})
