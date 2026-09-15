import { describe, it, expect } from 'vitest'

import { extractPlainText, renderContentMarkup } from '../../../server/utils/content-markup'

/**
 * The renderer's output goes to `v-html`, so the escaping tests here are the
 * ones that matter: every other assertion is about formatting, and a formatting
 * bug shows up on screen. An escaping bug does not.
 *
 * `escapeHtml` itself is covered in `stream.test.ts`, which owns it. What is
 * asserted here is the property that depends on this file: that every path
 * through the renderer runs source through it before any markup rule.
 */

describe('renderContentMarkup — escaping', () => {
  it('escapes a tag in a paragraph', () => {
    expect(renderContentMarkup('<script>alert(1)</script>')).toBe(
      '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>',
    )
  })

  it('escapes a tag inside a code span', () => {
    expect(renderContentMarkup('use `<img onerror=x>` here')).toBe(
      '<p>use <code>&lt;img onerror=x&gt;</code> here</p>',
    )
  })

  it('escapes a tag inside a fenced code block', () => {
    expect(renderContentMarkup('```\n<b>hi</b>\n```')).toBe(
      '<pre><code>&lt;b&gt;hi&lt;/b&gt;</code></pre>',
    )
  })

  it('escapes a quote in a link label so it cannot close the attribute', () => {
    expect(renderContentMarkup('[a" onmouseover="x](/safe)')).toBe(
      '<p><a href="/safe">a&quot; onmouseover=&quot;x</a></p>',
    )
  })

  it('escapes a quote in a link target so it cannot close the attribute', () => {
    // The target runs to the first `)`, so the trailing one stays as text —
    // what matters is that the quotes inside the attribute are escaped and the
    // handler never becomes one.
    const html = renderContentMarkup('[label](/a"onmouseover="alert(1))')
    expect(html).toContain('href="/a&quot;onmouseover=&quot;alert(1"')
    expect(html).not.toContain('onmouseover="alert')
  })
})

describe('renderContentMarkup — link schemes', () => {
  it.each([
    'https://example.com',
    'http://example.com',
    'mailto:a@example.com',
    '/local',
    '#anchor',
  ])('emits an anchor for %s', (url) => {
    expect(renderContentMarkup(`[label](${url})`)).toBe(`<p><a href="${url}">label</a></p>`)
  })

  it.each([
    'javascript:alert(1)',
    'JavaScript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox',
    'file:///etc/passwd',
  ])('renders %s as text rather than a link', (url) => {
    const html = renderContentMarkup(`[label](${url})`)
    expect(html).not.toContain('<a ')
    expect(html).toContain('[label]')
  })

  it('does not resurrect a scheme smuggled through an HTML entity', () => {
    // `&#106;avascript:` would be `javascript:` if the entity were decoded. The
    // escape pass turns its `&` into `&amp;`, so no browser decodes it — and the
    // prefix check rejects it anyway.
    const html = renderContentMarkup('[label](&#106;avascript:alert(1))')
    expect(html).not.toContain('<a ')
    expect(html).toContain('&amp;#106;')
  })
})

describe('renderContentMarkup — blocks', () => {
  it('renders a paragraph, joining its lines with a space', () => {
    expect(renderContentMarkup('one\ntwo')).toBe('<p>one two</p>')
  })

  it('separates paragraphs on a blank line', () => {
    expect(renderContentMarkup('one\n\ntwo')).toBe('<p>one</p><p>two</p>')
  })

  it('renders a heading', () => {
    expect(renderContentMarkup('### Title')).toBe('<h3>Title</h3>')
  })

  it('ends a paragraph at a heading without needing a blank line', () => {
    expect(renderContentMarkup('text\n### Title')).toBe('<p>text</p><h3>Title</h3>')
  })

  it('groups consecutive list items into one list', () => {
    expect(renderContentMarkup('- a\n- b')).toBe('<ul><li>a</li><li>b</li></ul>')
  })

  it('ends a list at a blank line and starts a paragraph', () => {
    expect(renderContentMarkup('- a\n\ntext')).toBe('<ul><li>a</li></ul><p>text</p>')
  })

  it('keeps blank lines and markers inside a fenced block', () => {
    expect(renderContentMarkup('```\n- not a list\n\n**not bold**\n```')).toBe(
      '<pre><code>- not a list\n\n**not bold**</code></pre>',
    )
  })

  it('closes an unterminated fence at the end of input rather than throwing', () => {
    expect(renderContentMarkup('```\nunclosed')).toBe('<pre><code>unclosed</code></pre>')
  })

  it('normalises CRLF input', () => {
    expect(renderContentMarkup('one\r\n\r\ntwo')).toBe('<p>one</p><p>two</p>')
  })

  it('renders empty source as empty output', () => {
    expect(renderContentMarkup('')).toBe('')
    expect(renderContentMarkup('\n\n  \n')).toBe('')
  })
})

describe('renderContentMarkup — inline', () => {
  it('renders bold and code', () => {
    expect(renderContentMarkup('**bold** and `code`')).toBe(
      '<p><strong>bold</strong> and <code>code</code></p>',
    )
  })

  it('does not apply bold inside a code span', () => {
    expect(renderContentMarkup('`**literal**`')).toBe('<p><code>**literal**</code></p>')
  })

  it('does not turn a link inside a code span into an anchor', () => {
    expect(renderContentMarkup('`[a](/b)`')).toBe('<p><code>[a](/b)</code></p>')
  })

  it('applies inline patterns on both sides of a code span', () => {
    expect(renderContentMarkup('**a** `c` **b**')).toBe(
      '<p><strong>a</strong> <code>c</code> <strong>b</strong></p>',
    )
  })

  it('leaves an unpaired back-tick as text', () => {
    expect(renderContentMarkup('a ` b')).toBe('<p>a ` b</p>')
  })

  it('renders inline markup inside list items and headings', () => {
    expect(renderContentMarkup('### A `b`')).toBe('<h3>A <code>b</code></h3>')
    expect(renderContentMarkup('- **a**')).toBe('<ul><li><strong>a</strong></li></ul>')
  })
})

describe('extractPlainText', () => {
  it('drops markers and joins blocks with a space', () => {
    expect(extractPlainText('### Title\n\n**bold** and `code`\n\n- item')).toBe(
      'Title bold and code item',
    )
  })

  it('keeps a link label and drops its target', () => {
    expect(extractPlainText('see [the docs](https://example.com)')).toBe('see the docs')
  })

  it('keeps the literal text of a rejected link', () => {
    expect(extractPlainText('[label](javascript:alert(1))')).toBe('[label](javascript:alert(1))')
  })

  it('omits code blocks, which are not prose', () => {
    expect(extractPlainText('text\n\n```\ncode\n```\n\nmore')).toBe('text more')
  })

  it('returns an empty string for empty source', () => {
    expect(extractPlainText('')).toBe('')
  })
})
