import { type Page, expect, test } from '@playwright/test'
import { login } from '../fixtures'
import { ACCOUNTS, WORLD } from '../seed-data'

/** Open the signed-in account's page from the header. */
async function openAccount(page: Page, username: string): Promise<void> {
  await page.getByRole('link', { name: username }).click()
  await expect(page.getByRole('heading', { name: 'Account', level: 1 })).toBeVisible()
}

const deletePanel = (page: Page) => page.getByLabel('Delete your account')

test('an owner is told which worlds block deletion, and is offered no delete button', async ({
  page,
}) => {
  await login(page, 'owner')
  await openAccount(page, ACCOUNTS.owner.username)

  const panel = deletePanel(page)
  await expect(panel.getByText(WORLD.name)).toBeVisible()
  await expect(panel.getByText(/Hand each one to another member/i)).toBeVisible()
  await expect(panel.getByRole('button', { name: 'Delete my account' })).toHaveCount(0)
})

/**
 * Runs against `e2e-disposable`, which exists for exactly this and belongs to
 * no world — the other seeded accounts are shared by every spec in the suite.
 */
test('an unblocked account exports its data, deletes itself, and cannot sign in again', async ({
  page,
}) => {
  const username = ACCOUNTS.disposable.username
  await login(page, 'disposable')
  await openAccount(page, username)

  const panel = deletePanel(page)
  await expect(panel.getByText(/cannot be undone and nothing is kept/i)).toBeVisible()

  // the export is offered before the irreversible action
  await panel.getByRole('button', { name: 'Prepare all my data for download' }).click()
  await expect(panel.getByRole('link', { name: 'Download all my data' })).toBeVisible()

  // confirmation step, then the password
  await panel.getByRole('button', { name: 'Delete my account' }).click()
  await panel.getByLabel('Your password').fill(ACCOUNTS.disposable.password)
  await panel.getByRole('button', { name: 'Permanently delete my account' }).click()

  await expect(page).toHaveURL(/\/login$/)

  // the credentials are dead
  await page.getByLabel('Username').fill(username)
  await page.getByLabel('Password').fill(ACCOUNTS.disposable.password)
  await page.getByRole('button', { name: 'Log in' }).click()
  await expect(page.getByRole('alert')).toBeVisible()
  await expect(page).toHaveURL(/\/login$/)
})
