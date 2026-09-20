# Images: smaller bytes, and a box that does not move

Two separate problems travel together under "image optimisation".

The first is **bytes**. A 1920×1080 JPEG is 57 kB in `public/`, and the phone
that downloads it can show 390 CSS pixels of it. Serving one file to every
viewport wastes most of it, and serving JPEG in 2026 wastes the rest — the same
frame is 26 kB as AVIF and 19 kB as WebP.

The second is **layout**. An image with no declared size occupies nothing until
its bytes arrive, so the browser lays the page out around a zero-height box and
then reflows everything below it. That is Cumulative Layout Shift, and it is
not fixed by making the image smaller — a fast image shifts the page just as
much as a slow one, only sooner.

`@nuxt/image` solves the first and merely _permits_ the second to be solved.
Every sizing prop on `<NuxtImg>`/`<NuxtPicture>` is optional, and an unsized
image renders happily. So this project adds one component in front of it,
`<AppImage>`, which will not render without an intrinsic box.

```
┌ author ───────────────┐   ┌ build/SSR ─────────────┐   ┌ runtime ──────────────┐
│ <AppImage             │   │ resolveImageBox()      │   │ GET /_ipx/f_avif&…    │
│   src width           │──▶│   width + ratio        │──▶│   sharp: decode,      │
│   ratio sizes         │   │   → width/height attrs │   │   resize, re-encode   │
│   priority />         │   │ assertResponsiveSizes()│   │   → image/avif        │
│                       │   │ <NuxtPicture>          │   │   cached on disk      │
│                       │   │   avif / webp / jpeg   │   │                       │
└───────────────────────┘   └────────────────────────┘   └───────────────────────┘
```

| File                      | What it owns                                            |
| ------------------------- | ------------------------------------------------------- |
| `image.config.ts`         | Formats, candidate widths, densities, quality, provider |
| `utils/imageRatio.ts`     | The intrinsic box arithmetic — pure                     |
| `utils/imageSizes.ts`     | Validation of the `sizes` expression — pure             |
| `components/AppImage.vue` | The component that refuses to render an unsized image   |
| `pages/images.vue`        | The live demo: `/images`                                |
| `public/images/`          | Sample sources, described below                         |

## Using it

```vue
<AppImage
  src="/images/hero-workspace.jpg"
  alt="A desk with a laptop and a mug"
  :width="1920"
  ratio="16/9"
  sizes="xs:100vw sm:100vw md:100vw lg:960px"
  priority
/>
```

| Prop       | Required | Notes                                                                 |
| ---------- | -------- | --------------------------------------------------------------------- |
| `src`      | yes      | Path under `public/`, or a URL on a host listed in `image.config.ts`  |
| `alt`      | yes      | `''` for an image that carries no information — but say so explicitly |
| `width`    | yes      | Intrinsic pixels; the largest variant worth generating                |
| `ratio`    | yes      | `'16/9'`, `'3:2'`, `'1.5'`, or the source's own size as `'1920/1080'` |
| `sizes`    | yes      | Screen-keyed widths — see below, this is the one that bites           |
| `priority` | no       | The LCP image, at most one per page: eager + preload + high priority  |
| `fit`      | no       | `cover` (default) or `contain`; applied by IPX _and_ by `object-fit`  |
| `quality`  | no       | 1–100, defaults to `IMAGE_QUALITY`                                    |
| `imgClass` | no       | Classes for the `<img>`; fallthrough classes land on the `<picture>`  |

Three of these throw rather than degrading — an unparseable `ratio`, a `width`
that is not a positive integer, and a `sizes` expression that does not name
configured screens. They are deterministic failures: any of them fails on the
first render, in `pnpm dev` and in `pnpm build` alike, so none can reach
production without failing locally first. A silent fallback would reintroduce
exactly the shift the component exists to prevent.

## `sizes` is not the HTML attribute

This is the sharp edge, and it is worth a section of its own.

`@nuxt/image` takes a _screen-keyed_ expression and generates both the `srcset`
candidates and the real `sizes` attribute from it:

```
sizes="xs:100vw md:50vw lg:600px"
      │  │     │           └── at ≥1024 CSS px, the image is 600px wide
      │  │     └───────────── at ≥768, half the viewport
      └──┴─────────────────── at ≥320, the full viewport
```

The keys come from `screens` in `image.config.ts`. Write the HTML attribute you
already know — `sizes="100vw"` — and the module does not reject it: an entry
with no colon is filed under the key `"1px"`, `Number.parseInt("1px")` is `1`,
and 100vw of a one-pixel screen is **a one-pixel-wide image**. The page renders,
the markup looks right, and the picture is a smudge.

`assertResponsiveSizes` in `utils/imageSizes.ts` is the guard, and
`tests/unit/utils/imageSizes.test.ts` is the proof. Write the expression against
the layout, and keep the largest candidate at or under the source's own width —
`sizes` times the largest density is what IPX is asked for, so `sm:100vw` on a
1200px source asks for 1280 and gets an upscale.

## Formats

`format: ['avif', 'webp']` becomes one `<source>` per entry, in that order, plus
a JPEG (or PNG, where the source may have alpha) `<img>` as the fallback. The
browser takes the **first** it can decode. It never compares sizes, so the order
is a decision.

AVIF leads because it wins on photographic content, which is what most sites are
mostly made of. It does not win on everything. The sample images here are flat
synthetic gradients — close to WebP's best case — and at q72 the hero measures:

| Variant   | AVIF    | WebP    | JPEG    |
| --------- | ------- | ------- | ------- |
| 1920×1080 | 26.2 kB | 19.1 kB | 59.7 kB |
| 640×360   | 6.9 kB  | 4.7 kB  | 11.7 kB |

WebP ahead of AVIF, both far ahead of the fallback. On a site of illustrations
or UI screenshots, `['webp', 'avif']` is the better bet, and that one line in
`image.config.ts` is the whole change.

## CLS: what actually reserves the space

Three things, and they have to agree:

1. **`width` and `height` attributes on the `<img>`.** The browser divides them
   to get an aspect ratio before any bytes arrive. `<AppImage>` derives `height`
   from `width` and `ratio` so the two cannot be typed into disagreement.
2. **`aspect-ratio` in CSS.** Belt and braces: the attributes stop implying a
   ratio the moment a stylesheet sets a height, and the CSS property survives
   that. It is emitted from the _unrounded_ ratio (`16 / 9`, not `1.7777…`), so
   it stays exact where the integer attributes cannot.
3. **Variants generated at the declared ratio.** `width` and `height` both reach
   IPX, so every candidate in the `srcset` is resized _and cropped_ to the box.
   Without this, a 3:4 source in a 1:1 box reserves a square and delivers a
   portrait — attributes correct, layout still wrong.

`tests/e2e/images.test.ts` asserts all three in a real browser, and measures the
page's actual CLS through a `PerformanceObserver`.

The one thing the unit suite cannot cover is `AppImage.vue` itself: the unit
tests run in the `node` environment with no SFC compiler, so `.vue` files are
not importable there. That is why the component holds no logic of its own — the
arithmetic lives in `utils/imageRatio.ts` and `utils/imageSizes.ts`, which are
pure and tested, and the wiring is covered end to end by the E2E suite.

## LCP: `priority`, and only once

`priority` does three things to the hero: `loading="eager"`,
`fetchpriority="high"` on the `<img>`, and a `<link rel="preload" as="image">`
carrying the first source's `imagesrcset`/`imagesizes` so the fetch starts
during head parsing rather than after layout.

It is a zero-sum hint. A second `priority` image does not make the first one
faster; it makes both of them slower. One per page.

Everything else gets `loading="lazy"` and `decoding="async"`.

## IPX, and what it costs

`provider: 'ipx'` runs the transforms inside this app's own Nitro server, on
`/_ipx/**`. It is named explicitly rather than left at `'auto'`, which resolves
against the deploy target — `'auto'` picks the platform CDN on Vercel or Netlify
and IPX on the Node preset this project builds and Dockerises with. Naming it
means a build behaves the same everywhere.

Two consequences worth knowing before you deploy:

- **`sharp` ships in the build.** The Nitro output grows from about 6 MB to
  about 27 MB, because libvips and its native binding are traced into
  `.output/server`. The build logs `sharp binaries have been included in your
build for linux-x64` — they are architecture-specific, so the builder image
  and the runner image must match. The `Dockerfile` here builds and runs on
  `node:22-alpine`, so both get the musl build.
- **The first request for a variant pays for it.** IPX decodes, resizes and
  re-encodes on demand and caches the result; AVIF is the slow one to encode.
  Put a CDN or a reverse-proxy cache in front of `/_ipx/**` in production.

`domains` is empty, and that is a security default rather than an oversight: an
open transformer will decode any image an attacker names, on your CPU, at any
width they ask for. Add the hosts you actually serve from.

To move the transforms off this server entirely, change `provider` and add a
provider block — the components, the props and everything in this document stay
the same.

## The sample images

`public/images/*.jpg` are four generated gradients, not photographs: 16:9, two
4:3, and one 3:4, each labelled with its own dimensions so a crop is visible at
a glance. They are synthetic on purpose — no licence to track, no faces, and
they compress in a way that makes the format comparison above reproducible.
Replace them; nothing outside `pages/images.vue` refers to them.

## Related

- `docs/web-vitals.md` — measuring the CLS and LCP this is aimed at, in the field
- `docs/bundle-budget.md` — the other half of the page-weight story, for JavaScript
