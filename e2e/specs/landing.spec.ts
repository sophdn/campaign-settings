import { expect, test } from '@playwright/test'
import { login } from '../fixtures'
import { ACCOUNTS } from '../seed-data'

/**
 * The public front door, and — more importantly — whether the instructions on
 * it are TRUE.
 *
 * The second test walks the landing page's four getting-started steps against
 * the running app, using the same words the page prints. A renamed button
 * therefore fails a test rather than quietly turning the page into fiction,
 * which is the only way a getting-started guide stays accurate as the UI moves.
 */

test('a visitor with no session gets the landing page, not a login form', async ({ page }) => {
  await page.goto('/')

  await expect(page.getByRole('heading', { name: 'CampaignSettings' })).toBeVisible()
  await expect(page.getByText(/decides who sees what/i)).toBeVisible()
  // no session was needed to read any of it
  await expect(page.getByRole('heading', { name: 'Log in' })).toHaveCount(0)
})

test('an unknown path lands on the landing page too, but a deep link still asks for a login', async ({
  page,
}) => {
  await page.goto('/nothing/here')
  await expect(page.getByRole('heading', { name: 'CampaignSettings' })).toBeVisible()

  await page.goto('/worlds/some-world/members')
  await expect(page.getByRole('heading', { name: 'Log in' })).toBeVisible()
})

test('the entry points it offers are the ones this deployment has switched on', async ({
  page,
}) => {
  // The e2e server runs every gate open, so all three doors should be present.
  await page.goto('/')

  await expect(page.getByRole('link', { name: 'Look around the demo' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Create an account' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Log in' })).toBeVisible()

  await page.getByRole('link', { name: 'Look around the demo' }).click()
  await expect(page.getByRole('heading', { name: 'Your worlds' })).toBeVisible()
})

test('the getting-started steps match the real UI, walked one by one', async ({ page }) => {
  // Step 0: read the instructions we are about to follow.
  await page.goto('/')
  const steps = page.getByRole('list').filter({ hasText: 'Create a world' })
  await expect(steps).toBeVisible()

  await login(page, 'owner')

  // Step 1 — "On Your worlds, type a name under New world and press Create."
  await expect(page.getByRole('heading', { name: 'Your worlds' })).toBeVisible()
  const worldName = 'Landing Walk'
  await page.getByLabel('World name').fill(worldName)
  await page
    .getByRole('form', { name: 'Create a world' })
    .getByRole('button', { name: 'Create' })
    .click()
  await expect(page).toHaveURL(/\/worlds\/[^/]+$/)
  const worldPath = new URL(page.url()).pathname

  // Step 2 — "Pick a kind from the world's left-hand rail — NPCs, say — type a
  // name, and press Add." The button is `Add`, not `Create`: this walk is what
  // caught the page saying otherwise.
  await page
    .getByRole('navigation', { name: 'World sections' })
    .getByRole('link', { name: 'NPCs' })
    .click()
  await page.getByLabel('Name').fill('Landing Walk NPC')
  await page.getByRole('form', { name: 'New npc' }).getByRole('button', { name: 'Add' }).click()
  await expect(page.getByRole('link', { name: 'Landing Walk NPC' })).toBeVisible()

  // Step 3 — "Open Members, then Invite. ... Copy the link as soon as it
  // appears, because it is shown exactly once."
  await page.getByRole('link', { name: 'Members' }).click()
  await expect(page.getByRole('heading', { name: 'Invite' })).toBeVisible()
  await page.getByLabel('Username (leave blank for an open link)').fill(ACCOUNTS.stranger.username)
  await page.getByRole('button', { name: 'Create invitation' }).click()
  await expect(page.getByText(/Copy this link now/)).toBeVisible()

  // Step 4 — "Every entry has a Who can see this control ... Pick the third and
  // press Grant beside each player who should see it."
  await page.goto(`${worldPath}/npc`)
  await page.getByRole('link', { name: 'Landing Walk NPC' }).click()
  await expect(page.getByRole('heading', { name: 'Who can see this' })).toBeVisible()
  await page.getByLabel('Visibility').selectOption({ label: 'Only the players you choose' })
  // the invited stranger has not accepted, so the only grantable member here is
  // whoever the world already has; assert the control reached its granting state
  await expect(
    page
      .getByRole('button', { name: /^Grant / })
      .or(page.getByText(/No players in this world yet/)),
  ).toBeVisible()
})
