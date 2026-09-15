import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, it, expect, vi } from 'vitest'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const ISLANDS_DIR = `${ROOT}/components/islands`

/**
 * The island contract, pinned in the three places it can quietly stop holding.
 *
 * **The flag.** `components/islands/` is only scanned as an island directory
 * when `experimental.componentIslands` is on. Turn it off and nothing fails:
 * `<NuxtIsland>` stops existing, and the page that used it fails at render time
 * rather than at build time.
 *
 * **The components.** Island markup is inert — there is no client-side Vue
 * instance behind it, so a click handler never fires and `onMounted` never runs.
 * Nothing warns about it; the page just renders and quietly does nothing. The
 * scan below is a source scan rather than a render test on purpose: what is
 * being asserted is a property of the *file*, and a render would only prove the
 * server half works.
 *
 * **The names.** `<NuxtIsland name="…">` resolves by string at runtime, so a
 * renamed component is a 404 from the island endpoint and an empty section on
 * the page, with nothing failing at build.
 */

/** Template bindings that need a client-side instance to do anything. */
const INTERACTIVE_TEMPLATE_PATTERNS = [
  { pattern: /\s@[a-zA-Z]/, what: 'an event handler (@…)' },
  { pattern: /\sv-on:/, what: 'an event handler (v-on:)' },
  { pattern: /\sv-model\b/, what: 'v-model' },
] as const

/** Lifecycle hooks that only ever run in the browser. */
const CLIENT_ONLY_HOOKS = [
  'onMounted',
  'onBeforeMount',
  'onUpdated',
  'onBeforeUpdate',
  'onUnmounted',
  'onBeforeUnmount',
  'onActivated',
  'onDeactivated',
  'onNuxtReady',
] as const

const islandFiles = readdirSync(ISLANDS_DIR).filter((name) => name.endsWith('.vue'))

function readIsland(name: string): string {
  return readFileSync(`${ISLANDS_DIR}/${name}`, 'utf8')
}

describe('nuxt.config', () => {
  it('enables component islands', async () => {
    // `defineNuxtConfig` is a Nuxt global; stubbed as identity so the config can
    // be imported and read as the plain object it is.
    vi.stubGlobal('defineNuxtConfig', <T>(config: T): T => config)

    const { default: config } = await import('../../nuxt.config')

    expect(config.experimental?.componentIslands).toBe(true)
  })
})

describe('components/islands', () => {
  it('contains the islands this app renders', () => {
    // Guards the per-file assertions below: an empty directory would make them
    // vacuous.
    expect(islandFiles).toContain('ContentSection.vue')
    expect(islandFiles).toContain('ContentIndex.vue')
  })

  it.each(islandFiles)('%s has no interactive template bindings', (name) => {
    const source = readIsland(name)

    for (const { pattern, what } of INTERACTIVE_TEMPLATE_PATTERNS) {
      expect(
        pattern.test(source),
        `${name} contains ${what}; island markup is inert, so it would never fire`,
      ).toBe(false)
    }
  })

  it.each(islandFiles)('%s registers no client-only lifecycle hook', (name) => {
    const source = readIsland(name)

    for (const hook of CLIENT_ONLY_HOOKS) {
      expect(
        new RegExp(`\\b${hook}\\s*\\(`).test(source),
        `${name} calls ${hook}, which never runs for an island`,
      ).toBe(false)
    }
  })
})

describe('pages/islands.vue', () => {
  const page = readFileSync(`${ROOT}/pages/islands.vue`, 'utf8')

  it('renders every island it names by a component that exists', () => {
    const names = [...page.matchAll(/<NuxtIsland[^>]*\sname="([^"]+)"/g)].map((match) => match[1])

    expect(names.length).toBeGreaterThan(0)
    for (const name of names) {
      expect(islandFiles, `<NuxtIsland name="${name}"> names no file`).toContain(`${name}.vue`)
    }
  })

  it('names every island component the directory holds', () => {
    // The other direction: an island nothing renders is dead code that still
    // compiles, and the demo is meant to exercise all of them.
    for (const file of islandFiles) {
      expect(page).toContain(`name="${file.replace(/\.vue$/, '')}"`)
    }
  })
})
