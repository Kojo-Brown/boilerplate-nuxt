import { describe, it, expect } from 'vitest'

import {
  IMAGE_DENSITIES,
  IMAGE_FORMATS,
  IMAGE_QUALITY,
  IMAGE_SCREENS,
  imageConfig,
} from '../../image.config'
import { assertResponsiveSizes } from '../../utils/imageSizes'

/**
 * These tests pin the image *contract*: which formats a browser is offered, at
 * which widths, and by which transformer. What the transformer then does with
 * a JPEG is IPX's own and is exercised by `pnpm build` plus a request to
 * `/_ipx/…` — see `docs/images.md`.
 *
 * Same reasoning as `tests/unit/route-rules.test.ts`: the config is in its own
 * module so it can be imported here, and what breaks silently in a config is a
 * dropped entry or a value that no longer agrees with the rest of the app.
 */

describe('image.config', () => {
  it('offers AVIF before WebP', () => {
    // Order is preference order: the browser takes the first `<source>` it can
    // decode, so a WebP-first list would never serve AVIF to anything.
    expect(imageConfig.format).toEqual(['avif', 'webp'])
  })

  it('leaves the legacy fallback to <NuxtPicture>', () => {
    // The component appends JPEG (or PNG for a source that may have alpha) as
    // the `<img>` itself. Listing it here would emit it twice.
    expect(IMAGE_FORMATS).not.toContain('jpeg')
    expect(IMAGE_FORMATS).not.toContain('png')
  })

  it('names the provider rather than leaving it to the deploy target', () => {
    expect(imageConfig.provider).toBe('ipx')
  })

  it('transforms nothing from a remote host by default', () => {
    // An open transformer decodes images an attacker chose, on this app's CPU.
    expect(imageConfig.domains).toEqual([])
  })

  it('caps densities at 2', () => {
    // The module itself warns above 2, and a 3x variant is 2.25x the bytes of
    // the 2x one for a difference no one can resolve at viewing distance.
    expect(IMAGE_DENSITIES).toEqual([1, 2])
    expect(Math.max(...IMAGE_DENSITIES)).toBeLessThanOrEqual(2)
  })

  it('uses one quality across all three formats', () => {
    expect(IMAGE_QUALITY).toBeGreaterThan(0)
    expect(IMAGE_QUALITY).toBeLessThanOrEqual(100)
    expect(imageConfig.quality).toBe(IMAGE_QUALITY)
  })
})

describe('image.config screens', () => {
  it('keeps Tailwind’s breakpoints at Tailwind’s values', () => {
    // `sizes` expressions in this app are written against the same scale the
    // layout is. A screen that drifts from its breakpoint makes every
    // `md:50vw` in the codebase quietly wrong.
    expect(IMAGE_SCREENS).toMatchObject({ sm: 640, md: 768, lg: 1024, xl: 1280, '2xl': 1536 })
  })

  it('adds a small end, because the default scale starts at 640', () => {
    // Without it a 320-wide phone at DPR 1 is served a 640-wide image.
    expect(IMAGE_SCREENS.xs).toBe(320)
  })

  it('adds a large end matching the widest source this project ships', () => {
    expect(IMAGE_SCREENS['3xl']).toBe(1920)
  })

  it('is ordered ascending, which is how it reads and how it is picked', () => {
    const widths = Object.values(IMAGE_SCREENS)
    expect([...widths].sort((a, b) => a - b)).toEqual(widths)
  })

  it('has no duplicate widths, which would make two keys interchangeable', () => {
    const widths = Object.values(IMAGE_SCREENS)
    expect(new Set(widths).size).toBe(widths.length)
  })

  it('exposes every key as usable in a sizes expression', () => {
    // The guard in `utils/imageSizes.ts` validates against these keys; this is
    // the other half of that contract.
    for (const screen of Object.keys(IMAGE_SCREENS)) {
      expect(() => assertResponsiveSizes(`${screen}:100vw`, IMAGE_SCREENS)).not.toThrow()
    }
  })
})
