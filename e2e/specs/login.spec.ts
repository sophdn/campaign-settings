import { expect, test } from '@playwright/test'
import { ACCOUNTS } from '../seed-data'

test('owner logs in and reaches the world picker', async ({ page }) => {
  await page.goto('/login')
  await page.getByLabel('Username').fill(ACCOUNTS.owner.username)
  await page.getByLabel('Password').fill(ACCOUNTS.owner.password)
  await page.getByRole('button', { name: 'Log in' }).click()
  await expect(page.getByRole('heading', { name: 'Your worlds' })).toBeVisible()
})

test('bad credentials surface an error and stay on login', async ({ page }) => {
  await page.goto('/login')
  await page.getByLabel('Username').fill('e2e-owner')
  await page.getByLabel('Password').fill('wrong-password')
  await page.getByRole('button', { name: 'Log in' }).click()
  await expect(page.getByRole('alert')).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Your worlds' })).toBeHidden()
})
