import { describe, it, expect } from 'vitest'

import { assertResponsiveSizes, parseSizesExpression } from '../../../utils/imageSizes'

import { IMAGE_SCREENS } from '../../../image.config'

/**
 * The guard in front of `@nuxt/image`'s `sizes` parser.
 *
 * The case worth reading is `sizes="100vw"`: valid-looking, accepted by the
 * module, and silently rendered as 100vw of a one-pixel screen. Everything else
 * here is scaffolding around making that one throw.
 */

const SCREENS = IMAGE_SCREENS

describe('parseSizesExpression', () => {
  it('splits on whitespace', () => {
    expect(parseSizesExpression('xs:100vw md:50vw')).toEqual([
      { screen: 'xs', width: '100vw' },
      { screen: 'md', width: '50vw' },
    ])
  })

  it('splits on commas too, as the module does', () => {
    expect(parseSizesExpression('xs:100vw, md:50vw')).toEqual([
      { screen: 'xs', width: '100vw' },
      { screen: 'md', width: '50vw' },
    ])
  })

  it('ignores runs of separators rather than emitting empty entries', () => {
    expect(parseSizesExpression('  xs:100vw   md:50vw  ')).toHaveLength(2)
  })

  it('returns a colonless entry with an empty screen instead of dropping it', () => {
    // Dropping it would hide exactly the mistake this module exists to catch.
    expect(parseSizesExpression('100vw')).toEqual([{ screen: '', width: '100vw' }])
  })

  it('is empty for an empty expression', () => {
    expect(parseSizesExpression('   ')).toEqual([])
  })
})

describe('assertResponsiveSizes', () => {
  it('accepts screen-keyed vw widths', () => {
    expect(() => assertResponsiveSizes('xs:100vw md:50vw', SCREENS)).not.toThrow()
  })

  it('accepts px widths and bare numbers', () => {
    expect(() => assertResponsiveSizes('lg:960px xl:1200', SCREENS)).not.toThrow()
  })

  it('accepts every configured screen as a key', () => {
    const everyScreen = Object.keys(SCREENS)
      .map((screen) => `${screen}:100vw`)
      .join(' ')
    expect(() => assertResponsiveSizes(everyScreen, SCREENS)).not.toThrow()
  })

  it('rejects the bare HTML-style expression that renders a one-pixel image', () => {
    expect(() => assertResponsiveSizes('100vw', SCREENS)).toThrow(/one-pixel image/)
  })

  it('rejects a screen that is not configured, and lists the ones that are', () => {
    expect(() => assertResponsiveSizes('tablet:50vw', SCREENS)).toThrow(/Unknown screen "tablet"/)
    expect(() => assertResponsiveSizes('tablet:50vw', SCREENS)).toThrow(/xs, sm, md, lg, xl/)
  })

  it('rejects a width in a unit the module cannot size against', () => {
    expect(() => assertResponsiveSizes('md:50em', SCREENS)).toThrow(/Invalid width "50em"/)
    expect(() => assertResponsiveSizes('md:calc(100vw-2rem)', SCREENS)).toThrow(/Invalid width/)
  })

  it('rejects an empty expression', () => {
    expect(() => assertResponsiveSizes('', SCREENS)).toThrow(/needs a `sizes` expression/)
  })

  it('checks every entry, not just the first', () => {
    expect(() => assertResponsiveSizes('xs:100vw md:50em', SCREENS)).toThrow(/Invalid width/)
  })

  it('does not treat inherited Object keys as configured screens', () => {
    // `screen in screens` would accept `constructor` and `toString`.
    expect(() => assertResponsiveSizes('constructor:50vw', SCREENS)).toThrow(/Unknown screen/)
  })
})
