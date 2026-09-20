/**
 * Validation for the `sizes` expression `@nuxt/image` takes.
 *
 * `sizes` looks like the HTML attribute of the same name and is not it. The
 * module parses `"xs:100vw md:50vw"` — a space-separated list of
 * `<screen>:<width>` pairs, where `<screen>` is a key from the configured
 * `screens` map — and generates both the `srcset` candidates and the real
 * `sizes` attribute from it.
 *
 * The failure mode is what makes this worth a module. `sizes="100vw"`, which is
 * what anyone who knows the HTML attribute writes first, is not rejected: an
 * entry with no colon is filed under the key `"1px"`, `Number.parseInt("1px")`
 * is `1`, and `100vw` of a 1-pixel screen is a **one pixel wide image**. The
 * page renders, the markup looks plausible, and the image is a smudge. Nothing
 * in the build says a word.
 *
 * So `components/AppImage.vue` checks the expression against the screens that
 * are actually configured before handing it over, and this is that check —
 * pure, so it can be tested without a browser or a Nuxt app.
 */

/** One `<screen>:<width>` pair from a `sizes` expression. */
export interface SizesEntry {
  /** The screen key, e.g. `'md'`. */
  readonly screen: string
  /** The width for that screen and up, e.g. `'50vw'` or `'600px'`. */
  readonly width: string
}

/** `50vw`, `600px` or a bare `600`, which the module reads as pixels. */
const WIDTH_PATTERN = /^\d+(?:\.\d+)?(?:vw|px)?$/

/**
 * Splits a `sizes` expression into its pairs, without validating them.
 *
 * Mirrors the module's own splitting (whitespace or commas), so what this
 * returns is what `@nuxt/image` will see — including the malformed entries,
 * which are returned with an empty `screen` rather than dropped. That is the
 * point: `assertResponsiveSizes` needs to see them to complain about them.
 */
export function parseSizesExpression(expression: string): SizesEntry[] {
  return expression
    .split(/[\s,]+/)
    .filter((entry) => entry.length > 0)
    .map((entry) => {
      const parts = entry.split(':')
      const [screen, width] = parts
      return parts.length === 2 && screen !== undefined && width !== undefined
        ? { screen: screen.trim(), width: width.trim() }
        : { screen: '', width: entry.trim() }
    })
}

/**
 * Throws unless every pair names a configured screen and a usable width.
 *
 * @param expression the `sizes` expression, e.g. `'xs:100vw md:50vw'`
 * @param screens the configured `screens` map — pass `useImage().options.screens`
 *   so the check is against what the app really runs with, not a copy of it
 * @throws {TypeError} naming the offending entry and the keys that would work
 */
export function assertResponsiveSizes(
  expression: string,
  screens: Readonly<Record<string, number>>,
): void {
  const entries = parseSizesExpression(expression)

  if (entries.length === 0) {
    throw new TypeError(
      'An image needs a `sizes` expression, e.g. "xs:100vw md:50vw". Without one the browser ' +
        'cannot pick a candidate and downloads the largest.',
    )
  }

  const known = Object.keys(screens)

  for (const { screen, width } of entries) {
    if (screen === '') {
      throw new TypeError(
        `Invalid sizes entry ${JSON.stringify(width)}: expected "<screen>:<width>". A bare width ` +
          `is silently read as the screen "1px" and renders a one-pixel image. Known screens: ${known.join(', ')}.`,
      )
    }

    if (!Object.hasOwn(screens, screen)) {
      throw new TypeError(
        `Unknown screen ${JSON.stringify(screen)} in sizes expression. Known screens: ${known.join(', ')}.`,
      )
    }

    if (!WIDTH_PATTERN.test(width)) {
      throw new TypeError(
        `Invalid width ${JSON.stringify(width)} for screen ${JSON.stringify(screen)}: expected a ` +
          'number of `vw`, a number of `px`, or a bare number read as pixels.',
      )
    }
  }
}
