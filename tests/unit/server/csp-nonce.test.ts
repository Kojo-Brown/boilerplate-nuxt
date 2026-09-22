import { describe, it, expect } from 'vitest'

import { createCspNonce, isCspNonce, stampNonce } from '~/server/utils/csp-nonce'

describe('createCspNonce', () => {
  it('produces a base64 value of 16 random bytes', () => {
    const nonce = createCspNonce()

    expect(isCspNonce(nonce)).toBe(true)
    // 16 bytes → 24 base64 characters including the two padding `=`.
    expect(nonce).toHaveLength(24)
    expect(Buffer.from(nonce, 'base64')).toHaveLength(16)
  })

  it('does not repeat', () => {
    const nonces = new Set(Array.from({ length: 500 }, createCspNonce))

    expect(nonces.size).toBe(500)
  })
})

describe('isCspNonce', () => {
  it('accepts base64, with or without padding', () => {
    expect(isCspNonce('c29tZS1ub25jZQ==')).toBe(true)
    expect(isCspNonce('abc+/123')).toBe(true)
  })

  it('rejects anything that could break out of an attribute', () => {
    expect(isCspNonce('')).toBe(false)
    expect(isCspNonce('abc"><script>alert(1)</script>')).toBe(false)
    expect(isCspNonce("abc'")).toBe(false)
    expect(isCspNonce('abc def')).toBe(false)
    expect(isCspNonce(undefined)).toBe(false)
    expect(isCspNonce(42)).toBe(false)
  })
})

describe('stampNonce', () => {
  const nonce = 'dGVzdC1ub25jZS12YWw='

  it('stamps a bare inline script', () => {
    expect(stampNonce('<script>window.x = 1</script>', nonce)).toBe(
      `<script nonce="${nonce}">window.x = 1</script>`,
    )
  })

  it('keeps the attributes a tag already has', () => {
    expect(stampNonce('<script type="importmap">{}</script>', nonce)).toBe(
      `<script type="importmap" nonce="${nonce}">{}</script>`,
    )
  })

  it('stamps src-carrying scripts too, so `strict-dynamic` stays a one-liner', () => {
    expect(stampNonce('<script type="module" src="/_nuxt/x.js" crossorigin></script>', nonce)).toBe(
      `<script type="module" src="/_nuxt/x.js" crossorigin nonce="${nonce}"></script>`,
    )
  })

  it('stamps style elements', () => {
    expect(stampNonce('<style>.a{color:red}</style>', nonce)).toBe(
      `<style nonce="${nonce}">.a{color:red}</style>`,
    )
  })

  it('stamps every tag in a chunk', () => {
    const stamped = stampNonce('<script>a()</script><div></div><style>b{}</style>', nonce)

    expect(stamped).toBe(
      `<script nonce="${nonce}">a()</script><div></div><style nonce="${nonce}">b{}</style>`,
    )
  })

  it('leaves a tag that already carries a nonce alone', () => {
    const markup = '<script nonce="b3RoZXI=">a()</script>'

    expect(stampNonce(markup, nonce)).toBe(markup)
  })

  it('does not put the slash of a self-closing tag inside the attribute run', () => {
    expect(stampNonce('<script src="/a.js" />', nonce)).toBe(
      `<script src="/a.js" nonce="${nonce}">`,
    )
  })

  it('leaves closing tags and unrelated markup untouched', () => {
    const markup = '<div class="script"><p>a &lt;script&gt; in text</p></div>'

    expect(stampNonce(markup, nonce)).toBe(markup)
  })

  it('refuses a nonce that could break out of the attribute', () => {
    expect(() => stampNonce('<script></script>', 'x"><script>alert(1)</script>')).toThrow(
      /malformed CSP nonce/,
    )
  })
})
