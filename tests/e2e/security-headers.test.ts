import { test, expect } from '@playwright/test'

/**
 * The half of the CSP story unit tests cannot reach.
 *
 * `tests/unit/server/` proves the policy string is what it should be and that
 * `stampNonce` writes the attribute. Only a browser can say whether the two
 * agree — whether the document Nuxt actually shipped boots under the policy the
 * response actually carried.
 *
 * Every assertion here holds against `pnpm dev` and against a built server.
 * Development runs a weaker policy (`'unsafe-eval'` for Vite's transform,
 * inline styles for the styles it injects from JavaScript — see
 * docs/security-headers.md), so this file asserts nothing about `style-src` and
 * nothing about directives that only tighten in a build.
 */

/** `nonce="…"` on every `<script>` / `<style>` opening tag in a document. */
function nonceAttributes(html: string): string[] {
  return [...html.matchAll(/<(?:script|style)(?:\s[^>]*)?>/gi)]
    .map((tag) => /\snonce="([^"]*)"/i.exec(tag[0])?.[1] ?? '')
    .filter((value) => value !== '')
}

/** Opening tags carrying no nonce at all. */
function unstampedTags(html: string): string[] {
  return [...html.matchAll(/<(?:script|style)(?:\s[^>]*)?>/gi)]
    .map((match) => match[0])
    .filter((tag) => !/\snonce=/i.test(tag))
}

test.describe('Security headers', () => {
  test('sends the static header set on a page response', async ({ page }) => {
    const response = await page.goto('/login')
    const headers = response?.headers() ?? {}

    expect(headers['x-content-type-options']).toBe('nosniff')
    expect(headers['x-frame-options']).toBe('DENY')
    expect(headers['referrer-policy']).toBe('strict-origin-when-cross-origin')
    expect(headers['cross-origin-opener-policy']).toBe('same-origin')
    expect(headers['cross-origin-resource-policy']).toBe('same-origin')
    expect(headers['permissions-policy']).toContain('camera=()')
  })

  test('the nonce in the header is the nonce in the document, and nothing is missed', async ({
    page,
  }) => {
    const response = await page.goto('/login')
    const policy = response?.headers()['content-security-policy'] ?? ''
    const html = (await response?.text()) ?? ''

    const headerNonce = /script-src [^;]*'nonce-([^']+)'/.exec(policy)?.[1]
    expect(headerNonce, `no nonce in script-src: ${policy}`).toBeTruthy()

    // Every inline tag carries one, and every one of them is that nonce.
    expect(unstampedTags(html)).toEqual([])
    expect([...new Set(nonceAttributes(html))]).toEqual([headerNonce])
  })

  test('a fresh nonce per response', async ({ page }) => {
    const first = (await page.goto('/login'))?.headers()['content-security-policy'] ?? ''
    const second = (await page.goto('/login'))?.headers()['content-security-policy'] ?? ''

    expect(first).not.toBe(second)
  })

  test('the policy blocks an inline script the page did not ship', async ({ page }) => {
    await page.addInitScript(() => {
      const violations: string[] = []
      Object.defineProperty(window, '__cspViolations', { value: violations })
      document.addEventListener('securitypolicyviolation', (event) => {
        violations.push(event.violatedDirective)
      })
    })
    await page.goto('/login')

    await page.evaluate(() => {
      const injected = document.createElement('script')
      injected.textContent = 'window.__executed = true'
      document.body.append(injected)
    })

    expect(await page.evaluate(() => '__executed' in window)).toBe(false)
    const violations = await page.evaluate(
      () => (window as unknown as { __cspViolations: string[] }).__cspViolations,
    )
    // Chrome reports the effective directive, `script-src-elem`, where another
    // engine may report the `script-src` it fell back from. Either is the same
    // fact, so match the family rather than one spelling.
    expect(violations.join(','), violations.join(',')).toMatch(/script-src/)
  })

  test('a page loads with no violations of its own', async ({ page }) => {
    await page.addInitScript(() => {
      const violations: string[] = []
      Object.defineProperty(window, '__cspViolations', { value: violations })
      document.addEventListener('securitypolicyviolation', (event) => {
        violations.push(`${event.violatedDirective} ${event.blockedURI}`)
      })
    })

    await page.goto('/login', { waitUntil: 'networkidle' })

    expect(
      await page.evaluate(
        () => (window as unknown as { __cspViolations: string[] }).__cspViolations,
      ),
    ).toEqual([])
  })

  test('a prerendered page is served the shared-HTML policy and no nonce', async ({ page }) => {
    // `/route-rules/static` carries `prerender: true`, so its HTML is the same
    // bytes for everyone and cannot hold a per-request value. See
    // docs/security-headers.md.
    const response = await page.goto('/route-rules/static')
    const policy = response?.headers()['content-security-policy'] ?? ''

    expect(policy).toContain("script-src 'self' 'unsafe-inline'")
    expect(policy).not.toContain('nonce-')
    expect(nonceAttributes((await response?.text()) ?? '')).toEqual([])
  })
})
