<script setup lang="ts">
import { computed, ref } from 'vue'

import { IMAGE_DENSITIES, IMAGE_FORMATS, IMAGE_QUALITY } from '~/image.config'

/**
 * Image optimisation — what `@nuxt/image` delivers, and what keeps it from
 * moving the page.
 *
 * Three things are on show here and all three are live rather than described:
 *
 *  1. **Format negotiation.** Every image below is a `<picture>` with an AVIF
 *     source, a WebP source and a JPEG `<img>` fallback. Open DevTools →
 *     Network and the `Type` column tells you which one this browser took.
 *  2. **Responsive widths.** The "what the browser is offered" panel prints the
 *     real `srcset` candidates for the hero, read back out of the same `$img`
 *     the component renders through — not a list typed into this page.
 *  3. **CLS.** Every image is inside an `<AppImage>`, which will not render
 *     without an intrinsic box. The demonstration at the bottom shows what the
 *     same image does without one.
 *
 * See `docs/images.md`.
 */
definePageMeta({ layout: false, title: 'Image optimisation' })

const HERO_WIDTH = 1920
const HERO_RATIO = '16/9'
const HERO_SRC = '/images/hero-workspace.jpg'
/**
 * The hero is full-bleed up to the content column, then fixed at its column
 * width. `lg:960px` is what caps the largest generated variant at 1920 — 960 at
 * density 2 — which is exactly the source's own width. Asking for more would
 * make IPX upscale.
 */
const HERO_SIZES = 'xs:100vw sm:100vw md:100vw lg:960px'

const cards = [
  {
    src: '/images/card-editor.jpg',
    alt: 'Sample image, orange gradient, 4 by 3',
    title: '4 : 3 source, 4 : 3 box',
    note: 'Box matches the source. No crop.',
    ratio: '4/3',
  },
  {
    src: '/images/card-terminal.jpg',
    alt: 'Sample image, green gradient, 4 by 3',
    title: '4 : 3 source, 1 : 1 box',
    note: 'IPX crops every variant to the square, so the reserved box is never wrong.',
    ratio: '1/1',
  },
  {
    src: '/images/card-portrait.jpg',
    alt: 'Sample image, violet gradient, 3 by 4',
    title: '3 : 4 source, 1 : 1 box',
    note: 'A portrait source in a square box — the crop is the transform, not CSS.',
    ratio: '1/1',
  },
] as const

/**
 * The grid is one column below `sm`, two up to `lg`, then three inside a
 * 960px container. `sm:50vw` rather than `100vw` matters: at `100vw` the 2x
 * candidate for the 640 screen is 1280, which is wider than these 1200px
 * sources, so IPX would be asked to upscale.
 */
const CARD_SIZES = 'xs:100vw sm:50vw md:50vw lg:320px'

const $img = useImage()

/**
 * The hero's real `srcset`, asked of the same `$img` instance the component
 * renders through. Printing what was configured would prove nothing; this
 * breaks if the screens, the densities or the `sizes` expression stop agreeing.
 */
const heroCandidates = computed(() => {
  const { srcset, sizes } = $img.getSizes(HERO_SRC, {
    sizes: HERO_SIZES,
    modifiers: { width: HERO_WIDTH, height: Math.round(HERO_WIDTH * (9 / 16)) },
  })
  const widths = srcset
    .split(',')
    .map((candidate) => candidate.trim().split(/\s+/).at(-1))
    .filter((descriptor): descriptor is string => descriptor !== undefined)
  return { widths, sizes }
})

/** The CLS demonstration is opt-in: it exists to move the page. */
const showUnsized = ref(false)
</script>

<template>
  <div class="min-h-screen bg-[var(--color-background)] p-8">
    <div class="mx-auto max-w-[960px] space-y-8">
      <NuxtLink
        to="/"
        class="text-sm text-[var(--color-muted-foreground)] hover:text-[var(--color-foreground)]"
      >
        ← Home
      </NuxtLink>

      <div>
        <h1 class="text-3xl font-bold text-[var(--color-foreground)]">
          Image optimisation
          <span class="ml-2 text-base font-normal text-[var(--color-muted-foreground)]">
            AVIF / WebP, responsive widths, zero layout shift
          </span>
        </h1>
        <p class="mt-1 text-[var(--color-muted-foreground)]">
          Every image on this page goes through
          <code class="font-mono text-xs">&lt;AppImage&gt;</code>, which will not render one without
          an intrinsic box.
        </p>
      </div>

      <!-- Hero: the LCP candidate. Eager, preloaded, high fetch priority. -->
      <section class="space-y-3">
        <h2 class="font-semibold text-[var(--color-foreground)]">
          Hero — the LCP image
          <span class="ml-2 text-xs font-normal text-[var(--color-muted-foreground)]">
            priority: eager + preload + fetchpriority="high"
          </span>
        </h2>

        <AppImage
          :src="HERO_SRC"
          alt="Sample image, blue gradient, 16 by 9"
          :width="HERO_WIDTH"
          :ratio="HERO_RATIO"
          :sizes="HERO_SIZES"
          priority
          class="block overflow-hidden rounded-xl border border-[var(--color-border)]"
        />

        <p class="text-xs text-[var(--color-muted-foreground)]">
          Exactly one image per page should carry <code class="font-mono">priority</code>. A second
          one does not make the first faster — it makes both compete.
        </p>
      </section>

      <!-- What the browser is actually offered. -->
      <section class="rounded-xl border border-[var(--color-border)] bg-[var(--color-muted)] p-5">
        <h2 class="mb-3 font-semibold text-[var(--color-foreground)]">
          What the browser is offered for the hero
        </h2>
        <dl class="space-y-3 text-sm">
          <div class="flex flex-wrap justify-between gap-2">
            <dt class="font-medium text-[var(--color-muted-foreground)]">Formats, best first</dt>
            <dd class="font-mono text-xs text-[var(--color-foreground)]">
              {{ IMAGE_FORMATS.join(' → ') }} → jpeg (fallback)
            </dd>
          </div>
          <div class="flex flex-wrap justify-between gap-2">
            <dt class="font-medium text-[var(--color-muted-foreground)]">srcset candidates</dt>
            <dd class="font-mono text-xs text-[var(--color-foreground)]">
              {{ heroCandidates.widths.join(', ') }}
            </dd>
          </div>
          <div class="flex flex-wrap justify-between gap-2">
            <dt class="font-medium text-[var(--color-muted-foreground)]">sizes attribute</dt>
            <dd
              class="max-w-[60ch] text-right font-mono text-xs break-all text-[var(--color-foreground)]"
            >
              {{ heroCandidates.sizes }}
            </dd>
          </div>
          <div class="flex flex-wrap justify-between gap-2">
            <dt class="font-medium text-[var(--color-muted-foreground)]">Densities · quality</dt>
            <dd class="font-mono text-xs text-[var(--color-foreground)]">
              {{ IMAGE_DENSITIES.map((d) => `${d}x`).join(' ') }} · q{{ IMAGE_QUALITY }}
            </dd>
          </div>
        </dl>
        <p class="mt-4 text-xs text-[var(--color-muted-foreground)]">
          Each candidate is transformed on demand by IPX at
          <code class="font-mono">/_ipx/…</code> and cached; none of them exist in
          <code class="font-mono">public/</code>.
        </p>
      </section>

      <!-- Ratio boxes: the crop is the transform, not CSS. -->
      <section class="space-y-3">
        <h2 class="font-semibold text-[var(--color-foreground)]">
          Declared ratios
          <span class="ml-2 text-xs font-normal text-[var(--color-muted-foreground)]">
            lazy, below the fold
          </span>
        </h2>

        <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <figure
            v-for="card in cards"
            :key="card.src"
            class="space-y-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-muted)] p-3"
          >
            <AppImage
              :src="card.src"
              :alt="card.alt"
              :width="640"
              :ratio="card.ratio"
              :sizes="CARD_SIZES"
              class="block overflow-hidden rounded-lg"
            />
            <figcaption class="space-y-1">
              <p class="text-sm font-medium text-[var(--color-foreground)]">{{ card.title }}</p>
              <p class="text-xs text-[var(--color-muted-foreground)]">{{ card.note }}</p>
            </figcaption>
          </figure>
        </div>
      </section>

      <!-- The shift itself. -->
      <section class="space-y-3">
        <h2 class="font-semibold text-[var(--color-foreground)]">What an unsized image does</h2>
        <p class="text-sm text-[var(--color-muted-foreground)]">
          The image below is the same file, rendered as a bare
          <code class="font-mono text-xs">&lt;img&gt;</code> with no width, height or
          <code class="font-mono text-xs">aspect-ratio</code>. Throttle the network in DevTools
          first, then reveal it: the paragraph under it starts directly below the heading and is
          pushed down when the bytes land. That displacement is the CLS.
        </p>

        <button
          type="button"
          class="rounded-md border border-[var(--color-border)] bg-[var(--color-background)] px-3 py-1.5 text-sm font-medium text-[var(--color-foreground)] hover:bg-[var(--color-muted)]"
          @click="showUnsized = !showUnsized"
        >
          {{ showUnsized ? 'Hide' : 'Reveal' }} the unsized image
        </button>

        <div
          v-if="showUnsized"
          class="rounded-xl border border-amber-200 bg-amber-50 p-4 dark:border-amber-800 dark:bg-amber-950/30"
        >
          <img
            :src="HERO_SRC"
            alt="The same sample image with no intrinsic dimensions"
            class="w-full rounded-lg"
          />
          <p class="mt-3 text-xs text-[var(--color-muted-foreground)]">
            This paragraph was here before the image loaded, one line below the button.
          </p>
        </div>
      </section>

      <section class="rounded-xl border border-[var(--color-border)] bg-[var(--color-muted)] p-5">
        <h2 class="mb-3 font-semibold text-[var(--color-foreground)]">Usage</h2>
        <pre
          class="overflow-x-auto rounded-md bg-[var(--color-background)] p-4 text-xs leading-relaxed text-[var(--color-foreground)]"
        ><code>&lt;AppImage
  src="/images/hero-workspace.jpg"
  alt="A desk with a laptop and a mug"
  :width="1920"
  ratio="16/9"
  sizes="xs:100vw sm:100vw md:100vw lg:960px"
  priority
/&gt;</code></pre>
        <p class="mt-4 text-xs text-[var(--color-muted-foreground)]">
          <code class="font-mono">width</code> plus one of <code class="font-mono">height</code> /
          <code class="font-mono">ratio</code> is required, and
          <code class="font-mono">sizes</code> is checked against the configured screens — a bare
          <code class="font-mono">sizes="100vw"</code> throws instead of quietly rendering a
          one-pixel image.
        </p>
      </section>
    </div>
  </div>
</template>
