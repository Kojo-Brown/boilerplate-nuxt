import { expect, test as setup } from '@playwright/test'

import { A11Y_AUTH_STATE } from '../../playwright.a11y.config'

/**
 * Signs in once and writes the session cookie to disk for the audit projects.
 *
 * A Playwright setup project rather than a fixture, because the audit needs the
 * *project's* context options — `colorScheme` above all — and a fixture that
 * builds its own context with `browser.newContext()` silently drops them. With
 * the session on disk, each audit project declares `storageState` in `use` and
 * the ordinary `page` fixture carries both the cookie and the colour scheme.
 */
setup('sign in and save the session', async ({ page }) => {
  // `networkidle`, not the default `load`: the form's submit handler is bound by
  // Vue on hydration, and a click that lands before it does performs a native
  // GET of the same page. That failure looks exactly like bad credentials.
  await page.goto('/login', { waitUntil: 'networkidle' })

  await page.locator('#email').fill('admin@example.com')
  await page.locator('#password').fill('password123')
  await page.locator('button[type="submit"]').click()

  // The redirect is the proof the session exists; asserting on it here means a
  // broken sign-in fails once, in a test named for it, rather than as twenty
  // audit failures that all report the wrong page.
  await page.waitForURL('/')
  await expect(page.getByText('admin@example.com')).toBeVisible()

  await page.context().storageState({ path: A11Y_AUTH_STATE })
})
