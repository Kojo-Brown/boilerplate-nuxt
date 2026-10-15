import { mountSuspended } from '@nuxt/test-utils/runtime'
import { beforeEach, describe, expect, it } from 'vitest'
import { nextTick } from 'vue'

import ColorModeToggle from '~/components/ColorModeToggle.vue'

/**
 * `ColorModeToggle` is three things at once: a component, `useAppColorMode`,
 * and `@nuxtjs/color-mode`'s client plugin. Only the middle one is reachable
 * from the node suite — `tests/unit/stores/preferences.test.ts` covers the store
 * it writes to — and the interesting half is the part that is not: a click has
 * to end with a class on `<html>`, because that is what every `.dark:` utility
 * in the stylesheet selects on.
 *
 * The plugin is real here. The inline script it normally relies on is not, since
 * there is no document to inject one into, so `tests/nuxt/setup.ts` installs the
 * `window.__NUXT_COLOR_MODE__` helper the plugin reads — built from the same
 * `#color-mode-options` the app is built from, so the class asserted below is
 * the class the module writes.
 */
describe('ColorModeToggle', () => {
  // One Nuxt app serves the whole file, so `useColorMode()` is the same state in
  // every test and `<html>` keeps whatever class the last one left on it.
  beforeEach(async () => {
    useColorMode().preference = 'system'
    await nextTick()
    document.documentElement.className = ''
  })

  it('offers to switch to dark while light', async () => {
    const toggle = await mountSuspended(ColorModeToggle)

    expect(toggle.get('button').attributes('aria-label')).toBe('Switch to dark mode')
    // The icon is the moon: what clicking gets you, not what you are in.
    expect(toggle.get('path').attributes('d')).toContain('M21 12.79A9 9 0 1 1 11.21 3')
  })

  it('puts the dark class on the document element when clicked', async () => {
    const toggle = await mountSuspended(ColorModeToggle)

    await toggle.get('button').trigger('click')
    await nextTick()

    expect(document.documentElement.classList.contains('dark')).toBe(true)
    expect(useColorMode().preference).toBe('dark')
  })

  it('offers to switch back once dark, and does', async () => {
    const toggle = await mountSuspended(ColorModeToggle)

    await toggle.get('button').trigger('click')
    await nextTick()
    expect(toggle.get('button').attributes('aria-label')).toBe('Switch to light mode')

    await toggle.get('button').trigger('click')
    await nextTick()

    expect(document.documentElement.classList.contains('dark')).toBe(false)
    expect(document.documentElement.classList.contains('light')).toBe(true)
    expect(useColorMode().preference).toBe('light')
  })

  it('records the preference in the store, not only in the module', async () => {
    const toggle = await mountSuspended(ColorModeToggle)

    await toggle.get('button').trigger('click')

    // `usePreferencesStore` is what survives a reload (`pinia-plugin-persistedstate`);
    // the module's own storage is written independently. A toggle that updated
    // only the module would come back to a store disagreeing with the page.
    expect(usePreferencesStore().colorMode).toBe('dark')
  })

  it('marks the active option in the segmented variant', async () => {
    const toggle = await mountSuspended(ColorModeToggle, { props: { variant: 'segmented' } })
    const pressed = () =>
      toggle
        .findAll('button')
        .filter((button) => button.attributes('aria-pressed') === 'true')
        .map((button) => button.text())

    expect(toggle.get('[role="group"]').attributes('aria-label')).toBe('Color mode')
    expect(pressed()).toEqual(['System'])

    await toggle.findAll('button')[1]?.trigger('click')
    await nextTick()

    expect(pressed()).toEqual(['Dark'])
    expect(document.documentElement.classList.contains('dark')).toBe(true)
  })

  it('keeps "system" selectable, which a two-state toggle cannot express', async () => {
    const toggle = await mountSuspended(ColorModeToggle, { props: { variant: 'segmented' } })

    await toggle.findAll('button')[0]?.trigger('click')
    await nextTick()
    expect(useColorMode().preference).toBe('light')

    await toggle.findAll('button')[2]?.trigger('click')
    await nextTick()

    expect(useColorMode().preference).toBe('system')
    // Resolved, not stored: `system` is a preference, and `value` is what it
    // resolves to against `prefers-color-scheme` — `light` here, since happy-dom
    // reports no preference and `nuxt.config.ts` sets `fallback: 'light'`.
    expect(useColorMode().value).toBe('light')
  })
})
