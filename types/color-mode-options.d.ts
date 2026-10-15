/**
 * Types for `#color-mode-options`, which `@nuxtjs/color-mode` generates and does
 * not declare.
 *
 * The alias is a build-time template: the module writes one `export const` per
 * resolved option, so the values are whatever `nuxt.config.ts` says plus the
 * module's defaults, and `plugin.client.ts` imports them. `tests/nuxt/setup.ts`
 * imports the same module to build the `window.__NUXT_COLOR_MODE__` helper from
 * the app's own configuration rather than from a copy of it — which is the whole
 * reason this declaration is worth having.
 *
 * Only the options used here are declared. Adding one means it is now read
 * somewhere, which is the right moment to decide what it is.
 */
declare module '#color-mode-options' {
  /** The `window` property the inline script hangs the helper off. */
  export const globalName: string
  /** Prefix and suffix around the class written to `<html>` — `''` here. */
  export const classPrefix: string
  export const classSuffix: string
  /** `data-<dataValue>` on `<html>`, or `''` for no attribute. */
  export const dataValue: string
  /** The scheme `system` resolves to when the browser states no preference. */
  export const fallback: string
}
