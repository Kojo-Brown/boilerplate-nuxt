import { vi } from 'vitest'

// Stub Nuxt auto-imports that are unavailable in the node test environment.
// Composables imported during tests resolve these from globalThis.
vi.stubGlobal('useNuxtApp', vi.fn())
vi.stubGlobal(
  'useRuntimeConfig',
  vi.fn(() => ({})),
)

// `defineNuxtRouteMiddleware` and `defineEventHandler` are identity wrappers that
// run at module-evaluation time. A `vi.stubGlobal` inside a test file is too late
// for a static import — ESM evaluates imports before any test-file statement — so
// they have to be stubbed here, in a setup file, which runs first.
vi.stubGlobal('defineNuxtRouteMiddleware', <T>(fn: T): T => fn)
vi.stubGlobal('defineEventHandler', <T>(fn: T): T => fn)

// Silence console.warn for known Nuxt SSR warnings in tests
const originalWarn = console.warn
console.warn = (...args: unknown[]) => {
  const msg = args[0]
  if (typeof msg === 'string' && msg.includes('[nuxt]')) return
  originalWarn(...args)
}
