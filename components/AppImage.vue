<script setup lang="ts">
import { computed } from 'vue'

import { IMAGE_QUALITY } from '~/image.config'
import { resolveImageBox } from '~/utils/imageRatio'
import { assertResponsiveSizes } from '~/utils/imageSizes'

/**
 * A responsive image that cannot shift the layout.
 *
 * `<NuxtPicture>` already does the hard part — one `<source>` per configured
 * format (AVIF, then WebP, then a JPEG/PNG `<img>` fallback), a `srcset` of
 * real widths, and a URL per variant that IPX transforms on demand. What it
 * does not do is *insist*: every sizing prop is optional, and an image with no
 * `width`/`height` renders happily and reflows the page when it lands.
 *
 * This component is that insistence, and nothing else:
 *
 *  - `width` and `ratio` are both required, and the intrinsic `height` is
 *    derived from them rather than typed a second time (`utils/imageRatio.ts`).
 *  - `width`+`height` also reach IPX as modifiers, so *every* srcset candidate
 *    is generated at the declared ratio. The reserved box and the delivered
 *    pixels agree at all widths — which is the half that `width`/`height`
 *    attributes alone do not guarantee when the source is a different shape.
 *  - `sizes` is checked against the configured screens, because the one
 *    expression everybody writes first — `sizes="100vw"` — is read by the
 *    module as "100vw of a 1px screen" and renders a one-pixel image without a
 *    single warning (`utils/imageSizes.ts`).
 *  - `priority` covers the LCP image: eager, `fetchpriority="high"`, and a
 *    `<link rel="preload">` for the first `<source>`. Everything else is lazy
 *    and `decoding="async"`.
 *
 * Both checks throw. They are deterministic — an unparseable ratio or a bad
 * `sizes` fails on the first render anywhere, including `pnpm build` and the
 * unit tests — so throwing cannot reach production without failing locally
 * first, and a silent fallback would reintroduce exactly the shift this exists
 * to stop.
 *
 * Fallthrough attributes land on the `<picture>` element, which is the layout
 * box; use `imgClass` to style the `<img>` inside it.
 *
 * ```vue
 * <AppImage
 *   src="/images/hero-workspace.jpg"
 *   alt="A desk with a laptop and a mug"
 *   :width="1600"
 *   ratio="16/9"
 *   sizes="xs:100vw md:100vw lg:960px"
 *   priority
 * />
 * ```
 *
 * See `docs/images.md`.
 */
interface Props {
  /** Path under `public/`, or an absolute URL on a host listed in `image.config.ts`. */
  src: string
  /** Alternative text. Pass `''` for an image that carries no information. */
  alt: string
  /** Screen-keyed widths, e.g. `'xs:100vw md:50vw lg:600px'`. */
  sizes: string
  /** Intrinsic width in pixels — the largest variant worth generating. */
  width: number
  /**
   * The box's ratio, e.g. `'16/9'`, `'3:2'` or `'1.5'`. Required: this is the
   * declaration that reserves the space. Write the source's own pixel size
   * (`'1920/1080'`) when that is what you mean.
   */
  ratio: string
  /** Encoder quality 1–100. Defaults to `IMAGE_QUALITY` from `image.config.ts`. */
  quality?: number
  /** How the source fills the declared box. Applied by IPX *and* by `object-fit`. */
  fit?: 'cover' | 'contain'
  /** Set on the one image that is likely the Largest Contentful Paint. At most one per page. */
  priority?: boolean
  /** Classes for the `<img>` itself; fallthrough classes go to `<picture>`. */
  imgClass?: string
}

// `quality` is defaulted here rather than left for the module to fill in:
// `<NuxtPicture>` types the prop as `string | number` with no `undefined`, so
// under `exactOptionalPropertyTypes` it cannot be passed through unset. Same
// constant either way — the one in `image.config.ts`.
const props = withDefaults(defineProps<Props>(), {
  quality: IMAGE_QUALITY,
  fit: 'cover',
  priority: false,
  imgClass: '',
})

const $img = useImage()

const box = computed(() => resolveImageBox(props.width, props.ratio))

const checkedSizes = computed(() => {
  assertResponsiveSizes(props.sizes, $img.options.screens)
  return props.sizes
})

/**
 * `preload` is an object rather than `true` so the emitted `<link>` carries
 * `fetchpriority="high"` as well. A preload without it competes with the rest
 * of the head for the same connection budget, which on a slow link can make
 * the hero *later* than no preload at all.
 */
const preload = computed(() => (props.priority ? { fetchPriority: 'high' as const } : false))

/**
 * `fetchpriority` has to travel in `imgAttrs`: `<NuxtPicture>` forwards a fixed
 * allow-list of attributes to the inner `<img>` and puts everything else on the
 * `<picture>`, where a fetch priority means nothing.
 *
 * `aspect-ratio` is belt and braces. The `width`/`height` attributes already
 * imply it, but they stop implying it the moment any stylesheet sets a height
 * — the CSS property survives that, and the box stays the right shape.
 */
const imgAttrs = computed(() => ({
  class: ['block h-auto w-full', props.imgClass],
  style: { aspectRatio: box.value.css, objectFit: props.fit },
  fetchpriority: props.priority ? ('high' as const) : ('auto' as const),
}))
</script>

<template>
  <NuxtPicture
    :src="src"
    :alt="alt"
    :sizes="checkedSizes"
    :width="box.width"
    :height="box.height"
    :quality="quality"
    :fit="fit"
    :preload="preload"
    :img-attrs="imgAttrs"
    :loading="priority ? 'eager' : 'lazy'"
    decoding="async"
  />
</template>
