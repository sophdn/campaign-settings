import { type Page, expect } from '@playwright/test'
import { ACCOUNTS, type AccountKey } from './seed-data'

/**
 * Log in through the real UI and assert we land on the world picker. Specs use
 * this instead of injecting a session cookie so the auth flow itself is covered.
 */
export async function login(page: Page, key: AccountKey = 'owner'): Promise<void> {
  const acct = ACCOUNTS[key]
  await page.goto('/login')
  await page.getByLabel('Username').fill(acct.username)
  await page.getByLabel('Password').fill(acct.password)
  await page.getByRole('button', { name: 'Log in' }).click()
  await expect(page.getByRole('heading', { name: 'Your worlds' })).toBeVisible()
}

/** Sign out through the header control, for specs that switch identities mid-test. */
export async function logout(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Log out' }).click()
  await expect(page).toHaveURL(/\/login$/)
}
