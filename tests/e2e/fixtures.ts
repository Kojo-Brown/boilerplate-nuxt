import { test as base, expect, type Page } from '@playwright/test'

type AuthenticatedFixture = {
  authenticatedPage: Page
}

export const test = base.extend<AuthenticatedFixture>({
  /**
   * Provides a Page already logged in with demo credentials.
   * Uses the credentials login endpoint: POST /api/auth/login.
   */
  authenticatedPage: async ({ browser }, use) => {
    const context = await browser.newContext()
    const page = await context.newPage()

    await page.goto('/login')
    await page.locator('#email').fill('admin@example.com')
    await page.locator('#password').fill('password123')
    await page.locator('button[type="submit"]').click()
    await page.waitForURL('/')

    await use(page)

    await context.close()
  },
})

export { expect }
