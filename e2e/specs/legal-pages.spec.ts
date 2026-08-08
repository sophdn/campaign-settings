import { expect, test } from '@playwright/test'

/**
 * Both pages must be reachable WITHOUT signing in — someone deciding whether to
 * register has to be able to read them first.
 */
test('terms and privacy are reachable from the login page with no session', async ({ page }) => {
  await page.goto('/login')

  await page.getByRole('link', { name: 'Privacy' }).click()
  await expect(page.getByRole('heading', { name: 'Privacy', level: 1 })).toBeVisible()

  await page.getByRole('link', { name: 'Terms of use' }).click()
  await expect(page.getByRole('heading', { name: 'Terms of use', level: 1 })).toBeVisible()
})

test('the registration form links both at the point of sign-up', async ({ page }) => {
  await page.goto('/register')
  await expect(page.getByRole('heading', { name: 'Create an account' })).toBeVisible()

  const form = page.getByRole('form', { name: 'Create an account' })
  await expect(form.getByRole('link', { name: 'terms of use' })).toBeVisible()
  await expect(form.getByRole('link', { name: 'privacy policy' })).toBeVisible()
})
