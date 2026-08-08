import { expect, test } from '@playwright/test'
import { login } from '../fixtures'

/**
 * Renaming, end to end, because the half that cannot be unit-tested is the
 * consequence: the world's address changes underneath the person doing it, and
 * the app has to carry them to the new one.
 *
 * Deliberately on a world of its own rather than the shared fixture. The specs
 * run against one seeded database, and a spec that renamed E2E World and failed
 * before renaming it back would take every later spec down with it.
 */
const BEFORE = 'Rename Fixture'
const AFTER = 'Rename Fixture Renamed'

test('the owner renames a world, and the app follows it to the new address', async ({ page }) => {
  await login(page, 'owner')
  await page.getByLabel('World name').fill(BEFORE)
  await page.getByRole('button', { name: 'Create' }).click()
  await expect(page).toHaveURL(/\/worlds\/[^/]+$/)
  // Read the address rather than assuming it: on a retry the fixture world from
  // the failed attempt is still in the shared database, and this one lands on a
  // deduplicated slug.
  const before = new URL(page.url()).pathname

  await page.getByRole('link', { name: 'Settings' }).click()
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible()
  // The consequence is stated before the button, not after the fact.
  await expect(page.getByText(/web address changes with the name/i)).toBeVisible()

  // Exact: the form's own accessible name is "World name", which a substring
  // match on "Name" also finds.
  await page.getByLabel('Name', { exact: true }).fill(AFTER)
  await page.getByRole('button', { name: 'Save name' }).click()

  // Moved, and the rail says which world this is without a reload.
  await expect(page).toHaveURL(/\/worlds\/rename-fixture-renamed[^/]*\/settings$/)
  await expect(page.getByText(AFTER)).toBeVisible()
  const after = new URL(page.url()).pathname.replace(/\/settings$/, '')
  expect(after).not.toBe(before)

  // The world really lives at the new address...
  await page.goto(after)
  await expect(page.getByRole('link', { name: 'Members' })).toBeVisible()
  // ...and the old one is gone, refused exactly as any address that is not
  // yours is refused — a rename tells a stranger nothing.
  await page.goto(before)
  await expect(page.getByRole('alert')).toBeVisible()
})

test('a player is not offered the settings surface', async ({ page }) => {
  await login(page, 'player1')
  await page.getByRole('link', { name: 'E2E World' }).click()
  await expect(page.getByRole('link', { name: 'Members' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Settings' })).toHaveCount(0)
})
