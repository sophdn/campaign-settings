import { type Page, expect, test } from '@playwright/test'
import { login, logout, openEntityEditor } from '../fixtures'
import { WORLD } from '../seed-data'

/**
 * The typed per-kind fields, end to end.
 *
 * The unit tests cover the registry, the coercion rules, and the rendering in
 * isolation. What only a real browser against a real server can prove is that
 * a value typed into one of these controls survives the whole round trip: the
 * flat merged shape the API returns, the base⋈detail split the content seam
 * does on write, and the reload that reads it back. That seam is the reason
 * these fields were invisible for so long, so it is the part worth exercising.
 *
 * Navigation goes through the URL rather than the nav rail, matching the other
 * specs: the world's own link exists only on the picker, so a helper that
 * assumed the rail would work once and hang thereafter.
 */

/** The seeded world's path, from the picker. */
async function openWorld(page: Page): Promise<string> {
  await page.goto('/')
  await page.getByRole('link', { name: WORLD.name }).click()
  await expect(page).toHaveURL(/\/worlds\/[^/]+$/)
  return new URL(page.url()).pathname
}

/** Open a kind's list page. */
async function openList(page: Page, kind: string): Promise<void> {
  const worldPath = await openWorld(page)
  await page.goto(`${worldPath}/${kind}`)
}

/**
 * Create an entity of a kind through the UI, land on its page, and open its
 * editor — the page now opens as readable prose with the form collapsed.
 */
async function createEntity(page: Page, kind: string, name: string): Promise<void> {
  await openList(page, kind)
  await page.getByLabel('Name').fill(name)
  await page.getByRole('button', { name: 'Add' }).click()
  await page.getByRole('link', { name, exact: true }).click()
  await openEntityEditor(page)
  await expect(page.getByLabel('Name')).toHaveValue(name)
}

test('an NPC’s occupation and species persist through a save and a reload', async ({ page }) => {
  await login(page, 'owner')

  // A species to point the NPC's ref field at. The picker offers what the wiki
  // index holds, so it has to exist before the NPC page is opened.
  await createEntity(page, 'species', 'Tideborn')

  // Its own NPC rather than the seeded one, which carries a passage — and that
  // panel has a Save button of its own, so `getByRole('button', {name: 'Save'})`
  // is ambiguous on its page. The other specs create per-test entities for the
  // same class of reason.
  await createEntity(page, 'npc', 'Quay Reeve')

  await page.getByLabel('Occupation').fill('Harbourmaster')
  await page.getByLabel('Species').selectOption({ label: 'Tideborn' })
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByText('Saved', { exact: true })).toBeVisible()

  // The reload is the assertion — it proves the detail row was written and
  // merged back onto the entity, not just held in React state.
  await page.reload()
  await openEntityEditor(page)
  await expect(page.getByLabel('Occupation')).toHaveValue('Harbourmaster')
  const chosen = await page.getByLabel('Species').locator('option:checked').textContent()
  expect(chosen).toBe('Tideborn')
})

test('a settlement’s size and wealth persist, and read back as their labels', async ({ page }) => {
  await login(page, 'owner')
  await createEntity(page, 'settlement', 'Saltmarket')

  await page.getByLabel('Size').selectOption('city')
  await page.getByLabel('Wealth').selectOption('rich')
  await page.getByLabel('Population').fill('4200')
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByText('Saved', { exact: true })).toBeVisible()

  const url = page.url()
  await page.reload()
  await openEntityEditor(page)
  await expect(page.getByLabel('Size')).toHaveValue('city')
  await expect(page.getByLabel('Wealth')).toHaveValue('rich')
  await expect(page.getByLabel('Population')).toHaveValue('4200')

  // A player reads the same settlement as labels, not as stored values.
  await logout(page)
  await login(page, 'player1')
  await page.goto(url)
  const details = page.getByLabel('Details')
  await expect(details).toContainText('City')
  await expect(details).toContainText('Rich')
  await expect(details).toContainText('4200')
})

test('a boolean field round-trips as a checkbox', async ({ page }) => {
  await login(page, 'owner')
  await createEntity(page, 'species', 'Marsh Wisp')

  // Both default true in the schema; clearing one is the interesting direction,
  // because `false` is exactly the value a naive "skip the empties" save drops.
  await expect(page.getByLabel('Corporeal')).toBeChecked()
  await page.getByLabel('Corporeal').uncheck()
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByText('Saved', { exact: true })).toBeVisible()

  await page.reload()
  await openEntityEditor(page)
  await expect(page.getByLabel('Corporeal')).not.toBeChecked()
  await expect(page.getByLabel('Sentient')).toBeChecked()
})
