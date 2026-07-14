import { test, expect } from './fixtures'

test.describe('Login form validation', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/login')
  })

  test('blocks submission when email field is empty', async ({ page }) => {
    await page.locator('#password').fill('password123')
    await page.locator('button[type="submit"]').click()

    // HTML required attribute prevents form submission; page stays on /login
    await expect(page).toHaveURL('/login')
    // email input should show browser validation state
    const emailValidity = await page.locator('#email').evaluate(
      (el) => (el as HTMLInputElement).validity.valueMissing,
    )
    expect(emailValidity).toBe(true)
  })

  test('blocks submission when password field is empty', async ({ page }) => {
    await page.locator('#email').fill('admin@example.com')
    await page.locator('button[type="submit"]').click()

    await expect(page).toHaveURL('/login')
    const passwordValidity = await page.locator('#password').evaluate(
      (el) => (el as HTMLInputElement).validity.valueMissing,
    )
    expect(passwordValidity).toBe(true)
  })

  test('blocks submission when email format is invalid', async ({ page }) => {
    await page.locator('#email').fill('not-an-email')
    await page.locator('#password').fill('password123')
    await page.locator('button[type="submit"]').click()

    await expect(page).toHaveURL('/login')
    const emailTypeMismatch = await page.locator('#email').evaluate(
      (el) => (el as HTMLInputElement).validity.typeMismatch,
    )
    expect(emailTypeMismatch).toBe(true)
  })

  test('blocks submission when both fields are empty', async ({ page }) => {
    await page.locator('button[type="submit"]').click()

    await expect(page).toHaveURL('/login')
  })

  test('clears error message when starting a new submission', async ({ page }) => {
    // First fail to populate the error
    await page.locator('#email').fill('wrong@example.com')
    await page.locator('#password').fill('wrongpassword')
    await page.locator('button[type="submit"]').click()
    await expect(page.locator('text=Invalid email or password')).toBeVisible()

    // Start a new submission with valid credentials
    await page.locator('#email').fill('admin@example.com')
    await page.locator('#password').fill('password123')
    await page.locator('button[type="submit"]').click()

    await page.waitForURL('/')
    // Error should be gone now that we're on the dashboard
    await expect(page.locator('h1')).toContainText('Dashboard')
  })
})
