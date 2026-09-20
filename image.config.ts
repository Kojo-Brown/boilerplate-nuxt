import type { ModuleOptions } from '@nuxt/image'

/**
 * The `@nuxt/image` contract: which provider transforms an image, which formats
 * a browser is offered, and at which widths.
 *
 * This lives in its own module, like `route-rules.config.ts`, for the same
 * reason: `nuxt.config.ts` runs through `defineNuxtConfig` and cannot be
 * imported into the Node test environment without dragging the whole Nuxt kit
 * along, so anything in it is untestable by construction. What can break
 * silently here is the config — a dropped format, a screen width that no longer
 * matches the Tailwind breakpoint the layout is written against — and
 * `tests/unit/image-config.test.ts` catches that.
 *
 * See `docs/images.md` for the delivery pipeline and the CLS rules that
 * `components/AppImage.vue` enforces on top of this.
 */

/**
 * Formats offered to the browser, best first.
 *
 * `<NuxtPicture>` turns this into one `<source type="image/…">` per entry, and
 * the browser takes the first it can decode. So this is a *preference* order,
 * not a size comparison: the browser never weighs the two against each other,
 * which is why the order is a decision and not a detail.
 *
 * AVIF leads because it wins on the content most sites are mostly made of —
 * photographs, and anything with grain or fine detail — where it is typically
 * 20–30% smaller than WebP at a matched quality. It does not win on everything.
 * The sample images in `public/images/` are flat synthetic gradients, which is
 * close to WebP's best case and AVIF's worst, and at q72 the hero measures:
 *
 *   1920×1080   AVIF 26.2 kB   WebP 19.1 kB   JPEG 59.7 kB
 *     640×360   AVIF  6.9 kB   WebP  4.7 kB   JPEG 11.7 kB
 *
 * — WebP ahead of AVIF, both far ahead of the fallback. Worth knowing before
 * assuming the order is free: on a site of illustrations or screenshots, `['webp',
 * 'avif']` is the better bet, and it is this one line that changes.
 *
 * WebP is listed second rather than dropped because AVIF is markedly slower to
 * encode — on a cold cache the first request for a large AVIF is the one a
 * visitor waits on — and because pre-16 Safari has WebP and not AVIF. Neither
 * JPEG nor PNG is listed: `<NuxtPicture>` appends one of them as the `<img>`
 * itself, picking PNG when the source may carry an alpha channel.
 */
export const IMAGE_FORMATS = ['avif', 'webp'] as const

/**
 * Candidate widths for a responsive `srcset`, in CSS pixels.
 *
 * These are Tailwind's breakpoints (the module's own default) plus `xs: 320`
 * and `3xl: 1920`. The small end matters because this project's image sizes are
 * written as `sizes="xs:100vw md:50vw"` against the same scale the layout uses
 * — a `srcset` that starts at 640 sends a 640-wide image to a 320-wide phone at
 * DPR 1, which is four times the pixels it can show.
 *
 * Each entry is a *candidate*, not a guarantee: a width is only rendered when
 * some `sizes` expression selects it, and each is then emitted at every density
 * below.
 */
export const IMAGE_SCREENS = {
  xs: 320,
  sm: 640,
  md: 768,
  lg: 1024,
  xl: 1280,
  '2xl': 1536,
  '3xl': 1920,
} as const satisfies ModuleOptions['screens']

/**
 * Device pixel ratios each selected width is emitted at.
 *
 * Capped at 2 on purpose. A 3x phone shows no more detail than a 2x one at
 * normal viewing distance — the module itself warns above 2 in dev — and the
 * third variant is 2.25× the bytes of the second for a difference nobody can
 * resolve.
 */
export const IMAGE_DENSITIES = [1, 2] as const satisfies ModuleOptions['densities']

/**
 * Default encoder quality, 1–100.
 *
 * 72 rather than the encoders' own defaults (AVIF 50, WebP 75, JPEG 80): one
 * number across three formats keeps the `<source>` list from being a quality
 * comparison as well as a format one, and 72 is above the point where AVIF's
 * chroma handling starts showing on flat gradients. Override per image with
 * `<AppImage :quality="…">` when a specific asset needs it — a screenshot of
 * text wants more, a blurred background wants much less.
 */
export const IMAGE_QUALITY = 72

export const imageConfig = {
  /**
   * IPX — the module's own transformer, running inside this app's Nitro server
   * on `/_ipx/**`. Explicit rather than left at `'auto'`, because `'auto'`
   * resolves against the deploy target: it picks the platform's image CDN on
   * Vercel or Netlify and IPX on the Node preset this project builds and
   * Dockerises with. Naming it means a build behaves the same everywhere, and
   * that switching to a CDN provider is a visible edit to this file rather than
   * a side effect of where the app was deployed. See `docs/images.md` for what
   * IPX needs at runtime (`sharp`, and a writable cache in front of it).
   */
  provider: 'ipx',

  format: [...IMAGE_FORMATS],
  screens: IMAGE_SCREENS,
  densities: [...IMAGE_DENSITIES],
  quality: IMAGE_QUALITY,

  /**
   * Remote hosts `<NuxtImg>`/`<NuxtPicture>` may transform.
   *
   * Empty means "this app's own `public/` only", which is the right default: an
   * open transformer is a denial-of-service amplifier — an attacker asks for a
   * hundred distinct widths of a 50-megapixel image on someone else's host and
   * IPX does the decoding. Add the hosts you actually serve images from.
   */
  domains: [],
} satisfies Partial<ModuleOptions>
