/**
 * The arithmetic behind a CLS-safe image box.
 *
 * Cumulative Layout Shift is caused by an image whose space is only known once
 * the bytes arrive: the browser lays the page out around a zero-height box,
 * then reflows everything below it. The fix is old and exact — give the `<img>`
 * an intrinsic `width` and `height` so the browser can compute the ratio before
 * a single byte of the image has loaded, and let CSS scale that box.
 *
 * The catch is that the two numbers have to *describe the source image*. They
 * are a ratio, not a size: `width="1600" height="900"` on an image that is
 * really 4:3 reserves the wrong box and shifts the page exactly as badly as no
 * attributes at all — worse, in fact, because it looks handled. So the numbers
 * want to be derived rather than typed twice, which is what this module is for
 * and why it is pure: `components/AppImage.vue` computes the box, the tests
 * pin the arithmetic, and neither needs a browser.
 *
 * Nothing here talks to `@nuxt/image`. The intrinsic box is a property of the
 * source asset and the layout, not of whoever resizes it.
 */

/** A width-to-height ratio. Both sides are finite and strictly positive. */
export interface AspectRatio {
  readonly width: number
  readonly height: number
}

/** A resolved intrinsic box, ready to put on an `<img>` and a wrapper. */
export interface ImageBox {
  /** The `width` attribute — intrinsic pixels, not a layout width. */
  readonly width: number
  /** The `height` attribute, derived from `width` and the ratio and rounded. */
  readonly height: number
  /** The ratio the two attributes encode, before rounding. */
  readonly ratio: AspectRatio
  /** The same ratio as a CSS `aspect-ratio` value, e.g. `'16 / 9'`. */
  readonly css: string
}

/**
 * `16/9`, `16:9`, `1.5`, `4 / 3` — a ratio written the way a person writes one.
 *
 * Both separators are accepted because both are in circulation: CSS
 * `aspect-ratio` uses `/`, and design tools and this project's own docs write
 * `16:9`. A bare decimal is accepted as width-over-height, which is what a
 * value pulled out of a CMS field usually is.
 */
const RATIO_PATTERN = /^(\d+(?:\.\d+)?)(?:\s*[:/]\s*(\d+(?:\.\d+)?))?$/

/**
 * Parses a ratio expression into its two sides.
 *
 * Throws rather than falling back to a default. A ratio that cannot be parsed
 * means the caller believes it is reserving space and is not, which is the
 * failure this whole module exists to prevent — it should surface as a loud
 * error in dev and in the tests, not as a silent `1 / 1` in production.
 *
 * @param input a ratio expression, e.g. `'16/9'`, `'3:2'` or `'1.777'`
 * @throws {TypeError} if `input` is not a ratio, or either side is zero
 */
export function parseAspectRatio(input: string): AspectRatio {
  const match = RATIO_PATTERN.exec(input.trim())
  if (!match) {
    throw new TypeError(
      `Invalid aspect ratio ${JSON.stringify(input)}: expected "W/H", "W:H" or a decimal.`,
    )
  }

  // Both groups are `\d+(\.\d+)?`, so neither can parse to NaN; only zero and
  // Infinity (a literal long enough to overflow a double) are reachable here.
  const width = Number(match[1])
  const height = match[2] === undefined ? 1 : Number(match[2])

  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new TypeError(
      `Invalid aspect ratio ${JSON.stringify(input)}: both sides must be finite and greater than zero.`,
    )
  }

  return { width, height }
}

/** The ratio as a single number, width over height. `16/9` → `1.777…`. */
export function aspectRatioDecimal(ratio: AspectRatio): number {
  return ratio.width / ratio.height
}

/**
 * The ratio as a CSS `aspect-ratio` value.
 *
 * Emitted as `'16 / 9'` rather than the computed decimal so the wrapper box and
 * the `<img>` attributes are the same two numbers. A decimal would round —
 * `1.7777777777777777` is not `16 / 9` — and a wrapper that is a fraction of a
 * pixel taller than the image it holds is a visible seam at some widths.
 */
export function cssAspectRatio(ratio: AspectRatio): string {
  return `${ratio.width} / ${ratio.height}`
}

/**
 * Resolves the intrinsic box an image should reserve.
 *
 * A ratio rather than a height, and required rather than optional, because
 * those are the two ways this goes wrong. An optional height is one a caller
 * forgets, and the page reflows; a height typed alongside a width is two
 * numbers that can disagree with each other and with the source. One ratio
 * cannot disagree with itself — and when the exact pixel size is what you have,
 * `ratio="1920/1080"` says it exactly.
 *
 * The derived height is rounded to a whole pixel, because `width`/`height` are
 * integer HTML attributes, so the attribute pair can differ from the exact
 * ratio by up to half a pixel. That is why `css` is built from the *unrounded*
 * ratio: the reserved area and the final image agree at every rendered width
 * even where the attributes cannot say so exactly.
 *
 * @param width intrinsic width in pixels — the largest variant worth generating
 * @param ratio a ratio expression, e.g. `'16/9'`, `'3:2'` or `'1.5'`
 * @throws {TypeError} on a non-positive or non-integer width, an unparseable
 * ratio, or a combination that derives a height below one pixel
 */
export function resolveImageBox(width: number, ratio: string): ImageBox {
  if (!Number.isInteger(width) || width <= 0) {
    throw new TypeError(`Invalid image width ${String(width)}: expected a positive integer.`)
  }

  const parsed = parseAspectRatio(ratio)
  const height = Math.round(width / aspectRatioDecimal(parsed))

  if (height < 1) {
    throw new TypeError(
      `Aspect ratio ${JSON.stringify(ratio)} at width ${width} derives a height below one pixel.`,
    )
  }

  return { width, height, ratio: parsed, css: cssAspectRatio(parsed) }
}
