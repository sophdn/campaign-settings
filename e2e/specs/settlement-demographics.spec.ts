import { expect, test } from '@playwright/test'
import { login, openEntityEditor } from '../fixtures'
import { WORLD } from '../seed-data'

/**
 * The demographics census, end to end.
 *
 * The model itself is pure and exhaustively unit-tested in shared; the panel's
 * rendering is covered by component tests. What needs a browser is the one step
 * that crosses everything: picking a role creates a real NPC through the API,
 * with the occupation already set, and lands the DM on it ready to be named.
 * That is the whole point of the census — turning "a city this size supports
 * smiths" into an NPC — and it spans the settlement's axes, the create route,
 * the detail-table write, and the navigation.
 */

test('a role on the census becomes a real NPC with its occupation set', async ({ page }) => {
  await login(page, 'owner')
  await page.goto('/')
  await page.getByRole('link', { name: WORLD.name }).click()
  await expect(page).toHaveURL(/\/worlds\/[^/]+$/)
  const worldPath = new URL(page.url()).pathname

  await page.goto(`${worldPath}/settlement`)
  await page.getByLabel('Name').fill('Census Harbour')
  await page.getByRole('button', { name: 'Add' }).click()
  await page.getByRole('link', { name: 'Census Harbour', exact: true }).click()
  await openEntityEditor(page)

  // No axes yet, so the model has nothing to estimate from and the panel is
  // absent — the same "no size, no panel" rule the unit tests pin.
  await expect(page.getByLabel('Demographics')).toHaveCount(0)

  await page.getByLabel('Size').selectOption('city')
  await page.getByLabel('Wealth').selectOption('rich')
  await page.getByLabel('Terrain').selectOption('coastal')
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByText('Saved', { exact: true })).toBeVisible()

  await page.reload()
  const panel = page.getByLabel('Demographics')
  await expect(panel).toBeVisible()
  await expect(panel).toContainText(/Estimated population:\s*\d+/)

  const firstRole = panel.locator('.denizen-list button').first()
  const role = ((await firstRole.textContent()) ?? '').trim()
  expect(role).not.toBe('')
  await firstRole.click()

  // Landed on a new NPC, named for the role, with the occupation already set —
  // which proves the detail-table write happened, not just the base row.
  await expect(page).toHaveURL(/\/worlds\/[^/]+\/npc\/[^/]+$/)
  await openEntityEditor(page)
  await expect(page.getByLabel('Name')).toHaveValue(role)
  await expect(page.getByLabel('Occupation')).toHaveValue(role)
})
