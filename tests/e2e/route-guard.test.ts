import { test, expect } from './fixtures'

test.describe('Route guard middleware', () => {
  test('redirects unauthenticated visitor from / to /login', async ({ page }) => {
    await page.goto('/')

    await page.waitForURL('/login')
    await expect(page.locator('#email')).toBeVisible()
  })

  test('redirects unauthenticated visitor from any protected route to /login', async ({ page }) => {
    await page.goto('/data-patterns')

    await page.waitForURL('/login')
    await expect(page.locator('#email')).toBeVisible()
  })

  test('redirects authenticated visitor from /login back to /', async ({ authenticatedPage }) => {
    await authenticatedPage.goto('/login')

    await authenticatedPage.waitForURL('/')
    await expect(authenticatedPage.locator('h1')).toContainText('Dashboard')
  })

  test('authenticated visitor can access protected routes directly', async ({
    authenticatedPage,
  }) => {
    await authenticatedPage.goto('/')

    await expect(authenticatedPage.locator('h1')).toContainText('Dashboard')
    await expect(authenticatedPage).toHaveURL('/')
  })

  test('after logout, re-visiting / redirects to /login', async ({ authenticatedPage }) => {
    // Confirm we're on the dashboard
    await expect(authenticatedPage.locator('h1')).toContainText('Dashboard')

    // Logout
    await authenticatedPage.locator('button:has-text("Sign out")').click()
    await authenticatedPage.waitForURL('/login')

    // Attempt to navigate back to dashboard
    await authenticatedPage.goto('/')
    await authenticatedPage.waitForURL('/login')
    await expect(authenticatedPage.locator('#email')).toBeVisible()
  })
})
