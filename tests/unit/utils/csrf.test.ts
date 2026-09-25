import { describe, it, expect, vi } from 'vitest'

import { CSRF_COOKIE_NAME, CSRF_COOKIE_SECURE_NAME, CSRF_HEADER_NAME } from '~/types/csrf'
import {
  browserCsrfSource,
  csrfRequestInit,
  parseCsrfCookie,
  resolveCsrfToken,
  type CsrfSource,
} from '~/utils/csrf'

/**
 * The browser half of the double submit.
 *
 * Everything that touches `document` or the network is behind `CsrfSource`, so
 * all of this runs in the `node` environment the rest of the suite uses. The one
 * function that reaches for globals is `browserCsrfSource`, and what is asserted
 * about it is exactly the property that makes calling any of this during SSR
 * safe: with no document it reports no token and does not try to fetch one.
 */

function source(overrides: Partial<CsrfSource> = {}): CsrfSource {
  return { cookies: null, mint: async () => null, ...overrides }
}

describe('parseCsrfCookie', () => {
  it('finds the token among other cookies', () => {
    const jar = `nuxt-color-mode=dark; ${CSRF_COOKIE_NAME}=abc123; i18n_redirected=en`
    expect(parseCsrfCookie(jar)).toBe('abc123')
  })

  it('prefers the __Host- cookie when a browser holds both', () => {
    const jar = `${CSRF_COOKIE_NAME}=from-dev; ${CSRF_COOKIE_SECURE_NAME}=from-tls`
    expect(parseCsrfCookie(jar)).toBe('from-tls')
  })

  it('decodes the percent-encoding h3 writes cookie values with', () => {
    expect(parseCsrfCookie(`${CSRF_COOKIE_NAME}=a%2Eb%2Ec`)).toBe('a.b.c')
  })

  it('reads a malformed escape as no token rather than throwing', () => {
    expect(parseCsrfCookie(`${CSRF_COOKIE_NAME}=%zz`)).toBeNull()
  })

  it('takes the first of a duplicated name, which is what a fetch sends', () => {
    const jar = `${CSRF_COOKIE_NAME}=first; ${CSRF_COOKIE_NAME}=second`
    expect(parseCsrfCookie(jar)).toBe('first')
  })

  it.each([
    ['no jar at all', null],
    ['an empty jar', ''],
    ['a jar with no CSRF cookie', 'nuxt-color-mode=dark'],
    ['an empty value', `${CSRF_COOKIE_NAME}=`],
    ['an entry with no separator', 'broken'],
  ])('returns null for %s', (_label, jar) => {
    expect(parseCsrfCookie(jar)).toBeNull()
  })
})

describe('resolveCsrfToken', () => {
  it('uses the cookie without asking the server for one', async () => {
    const mint = vi.fn(async () => 'minted')

    await expect(
      resolveCsrfToken(source({ cookies: `${CSRF_COOKIE_NAME}=from-cookie`, mint })),
    ).resolves.toBe('from-cookie')
    expect(mint).not.toHaveBeenCalled()
  })

  it('mints one when there is no cookie — a visitor whose first page was cached', async () => {
    await expect(resolveCsrfToken(source({ mint: async () => 'minted' }))).resolves.toBe('minted')
  })

  it('reports no token when it cannot get one, leaving the 403 to explain why', async () => {
    await expect(resolveCsrfToken(source())).resolves.toBeNull()
  })
})

describe('csrfRequestInit', () => {
  it('produces the header the middleware checks', async () => {
    const init = await csrfRequestInit(source({ cookies: `${CSRF_COOKIE_NAME}=abc` }))

    expect(init).toEqual({ headers: { [CSRF_HEADER_NAME]: 'abc' } })
  })

  it('produces nothing at all when there is no token', async () => {
    // Not `{ headers: {} }`: spread into a call's options, that would replace
    // whatever headers the call already sets — `if-match` on the todo gateway's
    // writes, for one.
    await expect(csrfRequestInit(source())).resolves.toEqual({})
  })
})

describe('browserCsrfSource', () => {
  it('reports no cookies and mints nothing where there is no document', async () => {
    // Which is server-side rendering, and is why spreading `csrfRequestInit()`
    // into an SSR fetch is a no-op rather than a crash.
    const outsideBrowser = browserCsrfSource()

    expect(outsideBrowser.cookies).toBeNull()
    await expect(outsideBrowser.mint()).resolves.toBeNull()
  })

  it('reads document.cookie when there is one', () => {
    vi.stubGlobal('document', { cookie: `${CSRF_COOKIE_NAME}=abc` })

    try {
      expect(parseCsrfCookie(browserCsrfSource().cookies)).toBe('abc')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('returns null rather than throwing when the mint request fails', async () => {
    vi.stubGlobal('document', { cookie: '' })
    vi.stubGlobal('$fetch', async () => {
      throw new Error('offline')
    })

    try {
      await expect(browserCsrfSource().mint()).resolves.toBeNull()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('returns the token the mint endpoint handed back', async () => {
    vi.stubGlobal('document', { cookie: '' })
    vi.stubGlobal('$fetch', async () => ({ token: 'fresh' }))

    try {
      await expect(browserCsrfSource().mint()).resolves.toBe('fresh')
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
