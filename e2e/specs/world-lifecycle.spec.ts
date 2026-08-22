import { type Page, expect, test } from '@playwright/test'
import { login, logout } from '../fixtures'
import { ACCOUNTS, WORLD } from '../seed-data'

/**
 * The transfer panel. Scoped because `getByLabel('Member')` also matches the
 * "Members" panel's own aria-label — substring matching, not a typo.
 */
const transferPanel = (page: Page) => page.getByLabel('Transfer ownership')

/** Open the seeded world's members page. */
async function openMembers(page: Page): Promise<void> {
  await page.getByRole('link', { name: WORLD.name }).click()
  await expect(page).toHaveURL(/\/worlds\/[^/]+$/)
  await page.getByRole('link', { name: 'Members' }).click()
  await expect(page.getByRole('heading', { name: 'Members' })).toBeVisible()
}

/**
 * The transfer round trip: the owner offers, the world does NOT change hands
 * until the recipient accepts, and once they do the roles have swapped. Run
 * before the leave test so it hands the world back and leaves the fixture as it
 * found it — the specs share one seeded database.
 */
test('ownership moves only once the recipient accepts, and swaps both roles', async ({ page }) => {
  const owner = ACCOUNTS.owner.username
  const player = ACCOUNTS.player1.username

  await login(page, 'owner')
  await openMembers(page)
  await transferPanel(page).getByLabel('Member', { exact: true }).selectOption({ label: player })
  await transferPanel(page).getByRole('button', { name: 'Offer ownership' }).click()

  // offered, but not transferred
  await expect(page.getByText(`Offered to ${player}`)).toBeVisible()
  await expect(page.getByText(/you are still the owner/i)).toBeVisible()
  // exact, or it also matches the `e2e-owner` username next to the badge
  await expect(
    page.getByLabel('Members', { exact: true }).getByText('owner', { exact: true }),
  ).toBeVisible()

  // the recipient accepts
  await logout(page)
  await login(page, 'player1')
  await openMembers(page)
  await page.getByRole('button', { name: 'Accept ownership' }).click()

  // both roles have swapped, in one step
  await expect(transferPanel(page)).toBeVisible()
  await expect(
    page.getByLabel('Members', { exact: true }).getByRole('button', { name: `Remove ${owner}` }),
  ).toBeVisible()

  // hand it back so the rest of the suite sees the fixture it expects
  await transferPanel(page).getByLabel('Member', { exact: true }).selectOption({ label: owner })
  await transferPanel(page).getByRole('button', { name: 'Offer ownership' }).click()
  await logout(page)
  await login(page, 'owner')
  await openMembers(page)
  await page.getByRole('button', { name: 'Accept ownership' }).click()
  await expect(transferPanel(page)).toBeVisible()
})

test('a player leaves the world and loses access to it', async ({ page }) => {
  await login(page, 'player2')
  await openMembers(page)

  const panel = page.getByLabel('Leave this world')
  await expect(panel.getByText(/permanently deletes your notes and characters/i)).toBeVisible()

  // the export is offered before the destructive action
  await panel.getByRole('button', { name: 'Prepare my data for download' }).click()
  await expect(panel.getByRole('link', { name: 'Download my notes and characters' })).toBeVisible()

  await panel.getByRole('button', { name: 'Leave this world' }).click()
  await panel.getByRole('button', { name: 'Yes, leave and delete my data' }).click()

  // back at the picker, and the world is no longer theirs to open
  await expect(page.getByRole('heading', { name: 'Your worlds' })).toBeVisible()
  await expect(page.getByRole('link', { name: WORLD.name })).toHaveCount(0)
})

test('the owner is offered a transfer instead of a leave button', async ({ page }) => {
  await login(page, 'owner')
  await openMembers(page)

  await expect(transferPanel(page)).toBeVisible()
  await expect(page.getByLabel('Leave this world')).toHaveCount(0)
})
