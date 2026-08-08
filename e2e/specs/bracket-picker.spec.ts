import { expect, test } from '@playwright/test'
import { login } from '../fixtures'
import { RESTRICTED_NPC, SEED_NPC, WORLD } from '../seed-data'

/**
 * The `[[name]]` picker, driven the way an author drives it.
 *
 * The keyboard path is the one asserted end to end: it is what a person writing
 * prose actually uses (hands already on the keys), and it is the path a mouse
 * test would not cover — arrow-key navigation and Enter-to-insert never run.
 */
async function openNotes(page: import('@playwright/test').Page): Promise<void> {
  await page.getByRole('link', { name: WORLD.name }).click()
  await expect(page).toHaveURL(/\/worlds\/[^/]+$/)
  await page.goto(`${new URL(page.url()).pathname}/notes`)
  await expect(page.getByRole('heading', { name: 'Notes' })).toBeVisible()
}

test('typing [[ suggests entities, and Enter inserts one that resolves to a link', async ({
  page,
}) => {
  await login(page, 'owner')
  await openNotes(page)

  const note = page.getByRole('combobox', { name: 'Note' })
  await note.click()
  await note.pressSequentially('Spoke to [[')

  // The list opens on the brackets alone, before anything is typed.
  const list = page.getByRole('listbox', { name: 'Entity suggestions' })
  await expect(list).toBeVisible()
  await expect(list.getByRole('option', { name: new RegExp(SEED_NPC.name) })).toBeVisible()

  // Narrow, then take it with the keyboard.
  await note.pressSequentially(SEED_NPC.name.slice(0, 4))
  await expect(list.getByRole('option').first()).toContainText(SEED_NPC.name)
  await note.press('Enter')

  await expect(list).toBeHidden()
  await expect(note).toHaveValue(`Spoke to [[${SEED_NPC.name}]]`)

  // The real proof: saved, it renders as a resolving link rather than red text.
  await page.getByRole('button', { name: 'Add note' }).click()
  const rendered = page.getByRole('link', { name: SEED_NPC.name })
  await expect(rendered.first()).toBeVisible()
})

test('Escape dismisses the list and leaves the text alone', async ({ page }) => {
  await login(page, 'owner')
  await openNotes(page)

  const note = page.getByRole('combobox', { name: 'Note' })
  await note.click()
  await note.pressSequentially('Meeting [[Te')
  await expect(page.getByRole('listbox', { name: 'Entity suggestions' })).toBeVisible()

  await note.press('Escape')
  await expect(page.getByRole('listbox', { name: 'Entity suggestions' })).toBeHidden()
  // An author naming something not yet created is doing so deliberately.
  await expect(note).toHaveValue('Meeting [[Te')
})

test('a player is never suggested an entity they cannot see', async ({ page }) => {
  await login(page, 'player2') // ungranted: the restricted npc is invisible to them
  await openNotes(page)

  const note = page.getByRole('combobox', { name: 'Note' })
  await note.click()
  await note.pressSequentially('Heard about [[')

  const list = page.getByRole('listbox', { name: 'Entity suggestions' })
  await expect(list).toBeVisible()
  await expect(list.getByRole('option', { name: new RegExp(SEED_NPC.name) })).toBeVisible()
  // The NAME itself must not appear. A suggestion row is the name, so showing it
  // would leak the secret without the entity ever being opened.
  await expect(list.getByRole('option', { name: new RegExp(RESTRICTED_NPC.name) })).toHaveCount(0)
})
