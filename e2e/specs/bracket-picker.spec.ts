import { expect, test } from '@playwright/test'
import { login, openEntityEditor, openPanel } from '../fixtures'
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

/**
 * The picker's output is now a relationship, not only a link.
 *
 * `[[bracket]]` mentions and typed relationships were two implementations of
 * one concept. What this asserts is that the two halves meet: a name inserted
 * by the picker, saved, produces a row in the Relationships panel — the author
 * never opens the relationship form.
 */
test('a name taken from the picker becomes a relationship on save', async ({ page }) => {
  await login(page, 'owner')
  const name = `Picker Source ${Date.now()}`

  // Its own NPC: the seeded one carries a staged passage that already relates
  // it to something, and this test is about the row it creates itself.
  await page.getByRole('link', { name: WORLD.name }).click()
  await expect(page).toHaveURL(/\/worlds\/[^/]+$/)
  const worldPath = new URL(page.url()).pathname
  await page.goto(`${worldPath}/npc`)
  await page.getByLabel('Name').fill(name)
  await page.getByRole('button', { name: 'Add' }).click()
  await page.getByRole('link', { name, exact: true }).click()
  await openEntityEditor(page)

  const body = page.getByRole('combobox', { name: 'Description' })
  await body.click()
  await body.pressSequentially(`Drinks with [[${SEED_NPC.name.slice(0, 4)}`)
  const list = page.getByRole('listbox', { name: 'Entity suggestions' })
  await expect(list.getByRole('option').first()).toContainText(SEED_NPC.name)
  await body.press('Enter')
  await expect(body).toHaveValue(`Drinks with [[${SEED_NPC.name}]]`)

  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByText('Saved', { exact: true })).toBeVisible()

  await page.reload()
  await openPanel(page, 'Relationships')
  await expect(
    page
      .getByRole('region', { name: 'Relationships' })
      .getByRole('listitem')
      .filter({ hasText: SEED_NPC.name })
      .getByText('Related to'),
  ).toBeVisible()
})
