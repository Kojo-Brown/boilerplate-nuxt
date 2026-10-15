import { mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import { nextTick } from 'vue'

import LanguageSwitcher from '~/components/LanguageSwitcher.vue'

/**
 * The i18n case. `useI18n()`, `$t` and `setLocale` are `@nuxtjs/i18n`'s
 * auto-imports, backed by the real message files and the real locale list from
 * `nuxt.config.ts` — none of which a stub in `tests/setup.ts` can stand in for
 * without the test becoming a test of the stub. Mounted here, "does the label
 * translate" is a question about `i18n/locales/*.json`.
 */
/**
 * The app-wide i18n instance. `useI18n()` is a composable and throws outside a
 * `setup()`, so a test body reads the global composer `@nuxtjs/i18n` installs on
 * the Nuxt app — the same object the component's `useI18n()` resolves to.
 */
function i18n() {
  return useNuxtApp().$i18n
}

describe('LanguageSwitcher', () => {
  // The locale is app-wide state and the app is shared by the whole file.
  afterEach(async () => {
    await i18n().setLocale('en')
  })

  it('labels the select from the message catalogue', async () => {
    const switcher = await mountSuspended(LanguageSwitcher)

    // Visually hidden, not absent: the control is a bare `<select>`, so without
    // it the only accessible name would be the selected option.
    const label = switcher.get('label')
    expect(label.text()).toBe('Language')
    expect(label.classes()).toContain('sr-only')
    expect(label.attributes('for')).toBe('language-select')
    expect(switcher.get('select').attributes('id')).toBe('language-select')
  })

  it('offers every configured locale by its own name', async () => {
    const switcher = await mountSuspended(LanguageSwitcher)
    const options = switcher.findAll('option')

    expect(options.map((option) => option.attributes('value'))).toEqual(['en', 'fr'])
    // The names are the locales' own, not translations of them: a French
    // speaker looking for their language looks for "Français".
    expect(options.map((option) => option.text())).toEqual(['English', 'Français'])
  })

  it('shows the active locale as selected', async () => {
    const switcher = await mountSuspended(LanguageSwitcher)

    expect(switcher.get('select').element.value).toBe('en')

    await i18n().setLocale('fr')
    await nextTick()

    expect(switcher.get('select').element.value).toBe('fr')
  })

  it('switches the application locale when an option is chosen', async () => {
    const switcher = await mountSuspended(LanguageSwitcher)
    const select = switcher.get('select')

    select.element.value = 'fr'
    await select.trigger('change')
    // `switchLocale` awaits `setLocale`, which resolves a route for the new
    // locale before it commits; a `nextTick` is one microtask short of that.
    await flushPromises()
    await nextTick()

    expect(i18n().locale.value).toBe('fr')
    // The component's own label is now French, which is the end-to-end claim:
    // the select changed the locale, and the locale changed the rendering.
    expect(switcher.get('label').text()).toBe('Langue')
  })

  it('ignores a value that is not a configured locale', async () => {
    const switcher = await mountSuspended(LanguageSwitcher)
    const select = switcher.get('select')

    // Not reachable through the UI, which is the point: `setLocale` is typed to
    // the configured codes and a `<select>` hands back a plain string, so the
    // component narrows through the known options rather than casting. This is
    // the branch that narrowing takes.
    select.element.value = 'de'
    await select.trigger('change')
    await flushPromises()
    await nextTick()

    expect(i18n().locale.value).toBe('en')
  })
})
