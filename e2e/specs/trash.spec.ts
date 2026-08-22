import { expect, test } from '@playwright/test'
import { login, logout, openEntityEditor } from '../fixtures'
import { WORLD } from '../seed-data'

/**
 * The round trip a deletion is supposed to have: delete an entity, find it in
 * the trash, put it back, and see it on the list again.
 *
 * Worth an end-to-end spec rather than only unit coverage because the claim is
 * about three surfaces agreeing — the entity page that deletes, the trash that
 * lists, and the entity list that has to show the restored row afterwards. Any
 * one of them can be right on its own while the journey is broken.
 *
 * Entities are created here rather than reusing the seed, so a failed run
 * cannot leave the shared seed world short an NPC for every later spec.
 */

const SUBJECT = 'Trash Spec Ghoul'
const DOOMED = 'Trash Spec Doomed'

/** Open the seeded world and return its path (the slug is deduplicated on retries). */
async function openWorld(page: import('@playwright/test').Page): Promise<string> {
  await page.getByRole('link', { name: WORLD.name }).click()
  await expect(page).toHaveURL(/\/worlds\/[^/]+$/)
  return new URL(page.url()).pathname
}

async function createNpc(
  page: import('@playwright/test').Page,
  worldPath: string,
  name: string,
): Promise<void> {
  await page.goto(`${worldPath}/npc`)
  await page.getByLabel('Name').fill(name)
  await page.getByRole('button', { name: 'Add' }).click()
  await expect(page.getByRole('link', { name })).toBeVisible()
}

test('a deleted entity lands in the trash and comes back from it', async ({ page }) => {
  await login(page, 'owner')
  const worldPath = await openWorld(page)
  await createNpc(page, worldPath, SUBJECT)

  await page.getByRole('link', { name: SUBJECT }).click()
  // Delete lives inside the editor, which is collapsed on arrival — that is
  // deliberate, so a destructive control is never one stray click from a page
  // you opened to read.
  await openEntityEditor(page)
  await page.getByRole('button', { name: 'Delete' }).click()
  await expect(page.getByRole('link', { name: SUBJECT })).toHaveCount(0)

  await page.getByRole('link', { name: 'Trash' }).click()
  await expect(page.getByRole('heading', { name: 'Trash' })).toBeVisible()
  await expect(
    page.getByRole('region', { name: 'Deleted NPC' }).getByText(SUBJECT, { exact: true }),
  ).toBeVisible()

  await page.getByRole('button', { name: `Restore ${SUBJECT}` }).click()
  // Asserted on the row's own control rather than its name: the name also
  // appears inside every button acting on it, and the seed world is shared, so
  // "the trash is empty" is not a claim this spec may make.
  await expect(page.getByRole('button', { name: `Restore ${SUBJECT}` })).toHaveCount(0)

  // Back on the list it came from, not merely absent from the trash.
  await page.goto(`${worldPath}/npc`)
  await expect(page.getByRole('link', { name: SUBJECT })).toBeVisible()
})

test('permanent deletion takes a second, named confirmation', async ({ page }) => {
  await login(page, 'owner')
  const worldPath = await openWorld(page)
  await createNpc(page, worldPath, DOOMED)

  await page.getByRole('link', { name: DOOMED }).click()
  await openEntityEditor(page)
  await page.getByRole('button', { name: 'Delete' }).click()
  await page.goto(`${worldPath}/trash`)

  // One click arms it and says what is about to happen, by name.
  await page.getByRole('button', { name: `Delete ${DOOMED} permanently` }).click()
  await expect(page.getByRole('alert')).toContainText(`Delete ${DOOMED} permanently?`)

  // Backing out leaves it exactly where it was.
  await page.getByRole('button', { name: `Keep ${DOOMED}` }).click()
  await expect(page.getByRole('alert')).toHaveCount(0)
  await expect(page.getByText(DOOMED, { exact: true })).toBeVisible()

  await page.getByRole('button', { name: `Delete ${DOOMED} permanently` }).click()
  await page.getByRole('button', { name: `Yes, delete ${DOOMED} permanently` }).click()
  await expect(page.getByText(DOOMED, { exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: `Restore ${DOOMED}` })).toHaveCount(0)
})

test('a player is offered no trash at all', async ({ page }) => {
  await login(page, 'owner')
  const worldPath = await openWorld(page)
  await logout(page)

  await login(page, 'player1')
  await openWorld(page)
  await expect(page.getByRole('link', { name: 'Trash' })).toHaveCount(0)

  // And the page itself says so rather than showing an empty list, for the
  // player who reaches it by typing the address.
  await page.goto(`${worldPath}/trash`)
  await expect(
    page.getByText('Only the GM can see what has been deleted from this world.'),
  ).toBeVisible()
})
