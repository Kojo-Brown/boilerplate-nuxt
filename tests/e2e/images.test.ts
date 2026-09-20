import { test, expect } from './fixtures'

/**
 * What `<AppImage>` actually puts in the document, and what the browser does
 * with it.
 *
 * The arithmetic behind the box is unit-tested (`tests/unit/utils/imageRatio.ts`
 * and `imageSizes.ts`); the component itself cannot be, because the unit suite
 * runs in the `node` environment with no SFC compiler. Everything that needs a
 * real browser is here: the `<source>` list, the intrinsic attributes, the
 * loading hints, the transform actually returning an AVIF — and the layout
 * shift, which is the only one of these that cannot be asserted from markup.
 */
test.describe('Image optimisation', () => {
  test('offers AVIF and WebP ahead of a JPEG fallback', async ({ authenticatedPage: page }) => {
    await page.goto('/images')

    const hero = page.locator('picture').first()
    const types = await hero
      .locator('source')
      .evaluateAll((sources) => sources.map((source) => source.getAttribute('type')))

    expect(types).toEqual(['image/avif', 'image/webp'])
    await expect(hero.locator('img')).toHaveAttribute('src', /f_jpeg/)
  })

  test('gives every image an intrinsic box', async ({ authenticatedPage: page }) => {
    await page.goto('/images')

    const images = page.locator('img[data-nuxt-pic]')
    await expect(images).not.toHaveCount(0)

    for (const image of await images.all()) {
      const width = Number(await image.getAttribute('width'))
      const height = Number(await image.getAttribute('height'))
      expect(width).toBeGreaterThan(0)
      expect(height).toBeGreaterThan(0)

      // The CSS ratio must agree with the attributes, or the two reserve
      // different boxes and the one that loses is the layout.
      const cssRatio = await image.evaluate((el) => getComputedStyle(el).aspectRatio)
      const [cssWidth, cssHeight] = cssRatio.split('/').map((part) => Number(part.trim()))
      expect(cssWidth).toBeGreaterThan(0)
      expect(cssHeight).toBeGreaterThan(0)
      expect((cssWidth as number) / (cssHeight as number)).toBeCloseTo(width / height, 2)
    }
  })

  test('loads the hero eagerly at high priority and the rest lazily', async ({
    authenticatedPage: page,
  }) => {
    await page.goto('/images')

    const images = page.locator('img[data-nuxt-pic]')
    const hero = images.first()
    await expect(hero).toHaveAttribute('loading', 'eager')
    await expect(hero).toHaveAttribute('fetchpriority', 'high')

    // Exactly one image may claim priority; a second one only adds contention.
    const eager = await images.evaluateAll(
      (els) => els.filter((el) => el.getAttribute('loading') === 'eager').length,
    )
    expect(eager).toBe(1)

    await expect(page.locator('link[rel="preload"][as="image"]')).toHaveAttribute(
      'imagesrcset',
      /f_avif/,
    )
  })

  test('serves the transformed variants the srcset promises', async ({
    authenticatedPage: page,
  }) => {
    await page.goto('/images')

    const srcset = await page
      .locator('picture source[type="image/avif"]')
      .first()
      .getAttribute('srcset')
    expect(srcset).toBeTruthy()

    const firstCandidate = (srcset as string).split(',')[0]?.trim().split(/\s+/)[0]
    expect(firstCandidate).toMatch(/^\/_ipx\//)

    const response = await page.request.get(firstCandidate as string)
    expect(response.status()).toBe(200)
    expect(response.headers()['content-type']).toBe('image/avif')
  })

  test('does not shift the layout while the images load', async ({ authenticatedPage: page }) => {
    await page.goto('/images', { waitUntil: 'load' })

    const cls = await page.evaluate(
      () =>
        new Promise<number>((resolve) => {
          let total = 0
          const observer = new PerformanceObserver((list) => {
            for (const entry of list.getEntries() as (PerformanceEntry & {
              value: number
              hadRecentInput: boolean
            })[]) {
              if (!entry.hadRecentInput) total += entry.value
            }
          })
          observer.observe({ type: 'layout-shift', buffered: true })
          setTimeout(() => {
            observer.disconnect()
            resolve(total)
          }, 1500)
        }),
    )

    // "Good" is 0.1; a page whose every image is sized should be at zero, and
    // the margin is only for sub-pixel rounding in the grid.
    expect(cls).toBeLessThan(0.01)
  })
})
