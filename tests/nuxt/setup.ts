import { classPrefix, classSuffix, dataValue, fallback, globalName } from '#color-mode-options'

/**
 * Setup for the Nuxt-environment suite. It runs before `@nuxt/test-utils`'
 * own setup entry — see `prependColorModeSetup` in `vitest.nuxt.config.ts` for
 * why the order is arranged explicitly rather than left to `setupFiles`.
 *
 * Only one thing needs doing, and it is the one piece of the real page that a
 * DOM environment has no way to produce by itself.
 */

/**
 * The helper `@nuxtjs/color-mode` normally gets from the blocking inline script
 * it injects into `<head>`.
 *
 * That script is what makes the module flash-free: it runs before the first
 * paint, reads the stored preference and puts the class on `<html>` before any
 * Vue code exists. In a test there is no document to inject it into, so
 * `plugin.client.ts`'s `window[globalName] || {}` falls back to `{}` and the
 * first colour-mode watcher call dies on `helper.getColorScheme is not a
 * function` — an unhandled error that surfaces as a crash in whichever test
 * happened to mount something, rather than in the module that caused it.
 *
 * This is a stub only in the sense that it does not read the stored preference:
 * the app's own `usePreferencesStore` does that, and `useColorMode().preference`
 * is what the tests drive. Everything else is the real script's behaviour, built
 * from the same `#color-mode-options` the app is built from, so a test asserting
 * on the `<html>` class is asserting about what the module really writes.
 */
function installColorModeHelper(): void {
  const root = window.document.documentElement
  const className = (value: string): string => `${classPrefix}${value}${classSuffix}`

  const getColorScheme = (): string => {
    for (const scheme of ['dark', 'light']) {
      if (window.matchMedia(`(prefers-color-scheme: ${scheme})`).matches) return scheme
    }
    return fallback
  }

  Object.defineProperty(window, globalName, {
    configurable: true,
    value: {
      preference: 'system',
      value: getColorScheme(),
      getColorScheme,
      addColorScheme(value: string) {
        root.classList.add(className(value))
        if (dataValue) root.setAttribute(`data-${dataValue}`, value)
      },
      removeColorScheme(value: string) {
        root.classList.remove(className(value))
        if (dataValue) root.removeAttribute(`data-${dataValue}`)
      },
    },
  })
}

installColorModeHelper()
