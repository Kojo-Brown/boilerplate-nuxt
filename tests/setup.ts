import { vi } from 'vitest'

// Stub Nuxt auto-imports that are unavailable in the node test environment.
// Composables imported during tests resolve these from globalThis.
vi.stubGlobal('useNuxtApp', vi.fn())
vi.stubGlobal('useRuntimeConfig', vi.fn(() => ({})))

// Silence console.warn for known Nuxt SSR warnings in tests
const originalWarn = console.warn
console.warn = (...args: unknown[]) => {
  const msg = args[0]
  if (typeof msg === 'string' && msg.includes('[nuxt]')) return
  originalWarn(...args)
}
