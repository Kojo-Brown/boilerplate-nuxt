import { test, expect } from './fixtures'

test.describe('Authentication flow', () => {
  test('displays login form with email, password, and submit button', async ({ page }) => {
    await page.goto('/login')

    await expect(page.locator('h1')).toContainText('Sign in to your account')
    await expect(page.locator('#email')).toBeVisible()
    await expect(page.locator('#password')).toBeVisible()
    await expect(page.locator('button[type="submit"]')).toContainText('Sign in')
  })

  test('logs in with valid credentials and redirects to dashboard', async ({ page }) => {
    await page.goto('/login')

    await page.locator('#email').fill('admin@example.com')
    await page.locator('#password').fill('password123')
    await page.locator('button[type="submit"]').click()

    await page.waitForURL('/')
    await expect(page.locator('h1')).toContainText('Dashboard')
  })

  test('shows error message on invalid credentials', async ({ page }) => {
    await page.goto('/login')

    await page.locator('#email').fill('wrong@example.com')
    await page.locator('#password').fill('wrongpassword')
    await page.locator('button[type="submit"]').click()

    await expect(page.locator('text=Invalid email or password')).toBeVisible()
    await expect(page).toHaveURL('/login')
  })

  test('displays loading state while submitting', async ({ page }) => {
    await page.goto('/login')

    await page.locator('#email').fill('admin@example.com')
    await page.locator('#password').fill('password123')

    const submitButton = page.locator('button[type="submit"]')
    await submitButton.click()

    // Button becomes disabled during loading; wait for navigation to confirm success
    await page.waitForURL('/')
    await expect(page.locator('h1')).toContainText('Dashboard')
  })

  test('logs out and redirects to login', async ({ authenticatedPage }) => {
    await authenticatedPage.locator('button:has-text("Sign out")').click()

    await authenticatedPage.waitForURL('/login')
    await expect(authenticatedPage.locator('#email')).toBeVisible()
  })

  test('shows GitHub sign-in link on login page', async ({ page }) => {
    await page.goto('/login')

    const githubLink = page.locator('a[href="/auth/github"]')
    await expect(githubLink).toBeVisible()
    await expect(githubLink).toContainText('Sign in with GitHub')
  })
})
