import { expect, test } from '@playwright/test'
import { login } from '../fixtures'
import { ACCOUNTS } from '../seed-data'

/**
 * Read-only on purpose: the seeded accounts are shared by every other spec, so
 * this exercises reachability and the session list without changing a
 * credential out from under them.
 */
test('the account page is reachable from the header and lists this session', async ({ page }) => {
  await login(page)

  await page.getByRole('link', { name: ACCOUNTS.owner.username }).click()
  await expect(page.getByRole('heading', { name: 'Account', level: 1 })).toBeVisible()

  // both self-service forms are present, and the password form demands the current one
  await expect(page.getByLabel('Current password')).toBeVisible()
  await expect(page.getByLabel('New password')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Save username' })).toBeVisible()

  // the session we just opened shows up, marked as this device
  await expect(page.getByText('— this device')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Sign out everywhere else' })).toBeVisible()
})
