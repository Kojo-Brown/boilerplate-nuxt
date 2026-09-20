import { describe, it, expect } from 'vitest'

import {
  aspectRatioDecimal,
  cssAspectRatio,
  parseAspectRatio,
  resolveImageBox,
} from '../../../utils/imageRatio'

/**
 * The arithmetic that keeps an image from moving the page.
 *
 * These are the assertions `components/AppImage.vue` is relying on and cannot
 * make itself: the unit suite runs in the `node` environment with no SFC
 * compiler, so a `.vue` component is not importable here (which is why the
 * component holds no logic of its own — see `docs/images.md`). What a browser
 * does with the resulting attributes is covered by `tests/e2e/images.test.ts`.
 */

describe('parseAspectRatio', () => {
  it('reads the slash form CSS uses', () => {
    expect(parseAspectRatio('16/9')).toEqual({ width: 16, height: 9 })
  })

  it('reads the colon form design tools use', () => {
    expect(parseAspectRatio('3:2')).toEqual({ width: 3, height: 2 })
  })

  it('reads a bare decimal as width over height', () => {
    expect(parseAspectRatio('1.5')).toEqual({ width: 1.5, height: 1 })
  })

  it('tolerates surrounding and interior whitespace', () => {
    expect(parseAspectRatio('  4 / 3  ')).toEqual({ width: 4, height: 3 })
  })

  it('accepts an exact pixel size as the ratio it is', () => {
    expect(parseAspectRatio('1920/1080')).toEqual({ width: 1920, height: 1080 })
  })

  it.each(['', 'sixteen/nine', '16/', '/9', '16//9', '16 9', '-16/9', '16/9/2'])(
    'rejects %o',
    (input) => {
      expect(() => parseAspectRatio(input)).toThrow(TypeError)
    },
  )

  it.each(['0/9', '16/0', '0'])('rejects %o, which has a zero side', (input) => {
    expect(() => parseAspectRatio(input)).toThrow(/greater than zero/)
  })

  it('names the offending input in the message, so the fix is obvious', () => {
    expect(() => parseAspectRatio('16 by 9')).toThrow(/"16 by 9"/)
  })
})

describe('aspectRatioDecimal', () => {
  it('divides width by height', () => {
    expect(aspectRatioDecimal({ width: 16, height: 9 })).toBeCloseTo(1.7778, 4)
    expect(aspectRatioDecimal({ width: 1, height: 1 })).toBe(1)
    expect(aspectRatioDecimal({ width: 3, height: 4 })).toBe(0.75)
  })
})

describe('cssAspectRatio', () => {
  it('keeps both sides rather than collapsing to a decimal', () => {
    expect(cssAspectRatio({ width: 16, height: 9 })).toBe('16 / 9')
  })

  it('is exact where a decimal would not be', () => {
    // `16 / 9` is 1.7777777777777777 as a double; a wrapper sized from that
    // rounding is a sub-pixel seam against an image sized from the attributes.
    expect(cssAspectRatio(parseAspectRatio('16/9'))).toBe('16 / 9')
  })
})

describe('resolveImageBox', () => {
  it('derives the height from the width and the ratio', () => {
    expect(resolveImageBox(1920, '16/9')).toEqual({
      width: 1920,
      height: 1080,
      ratio: { width: 16, height: 9 },
      css: '16 / 9',
    })
  })

  it('rounds a height that is not a whole pixel', () => {
    // 640 / (1.5) = 426.66…
    expect(resolveImageBox(640, '1.5').height).toBe(427)
  })

  it('reports the css ratio unrounded, so the reserved box stays exact', () => {
    const box = resolveImageBox(640, '1.5')
    expect(box.css).toBe('1.5 / 1')
    // The attributes cannot express 1.5 exactly at this width; the CSS can.
    expect(box.width / box.height).not.toBe(1.5)
  })

  it('handles a portrait ratio', () => {
    expect(resolveImageBox(900, '3/4')).toMatchObject({ width: 900, height: 1200 })
  })

  it('handles a square', () => {
    expect(resolveImageBox(640, '1/1')).toMatchObject({ width: 640, height: 640 })
  })

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('rejects the width %o', (width) => {
    expect(() => resolveImageBox(width, '16/9')).toThrow(/Invalid image width/)
  })

  it('propagates an unparseable ratio rather than guessing a square', () => {
    expect(() => resolveImageBox(640, 'wide')).toThrow(TypeError)
  })

  it('rejects a ratio so wide the height rounds away entirely', () => {
    expect(() => resolveImageBox(1, '10000/1')).toThrow(/below one pixel/)
  })
})
