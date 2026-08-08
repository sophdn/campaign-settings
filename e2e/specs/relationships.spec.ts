import { type Locator, type Page, expect, test } from '@playwright/test'
import { login, logout } from '../fixtures'
import { RESTRICTED_NPC, WORLD } from '../seed-data'

/**
 * Typed relationships, end to end.
 *
 * The two claims a browser is needed for: ONE stored row renders correctly on
 * BOTH entities' pages, with the inverse label on the far side; and a
 * relationship naming an entity the reader cannot see is absent from their page
 * entirely rather than shown with the name blanked.
 *
 * Every test creates its OWN npc. The e2e database is seeded once for the whole
 * run and the specs share it, so relating the same seeded npc in each test would
 * leave earlier tests' rows on the page and make later assertions ambiguous.
 */

/**
 * The list of asserted relationships — NOT the region, which also contains the
 * add-form whose `<select>` options spell out every type name in the vocabulary.
 */
const relationshipRows = (page: Page): Locator =>
  page.getByRole('region', { name: 'Relationships' }).getByRole('list')

/**
 * Open the seeded world's npc list, from wherever the test currently is.
 *
 * Starts at the world picker every time: the world's own link exists only
 * there, so a helper that assumed it was already on the picker would work on
 * its first call and hang on every later one.
 */
async function openNpcList(page: Page): Promise<void> {
  await page.goto('/')
  await page.getByRole('link', { name: WORLD.name }).click()
  await expect(page).toHaveURL(/\/worlds\/[^/]+$/)
  await page.goto(`${new URL(page.url()).pathname}/npc`)
}

/** Create a fresh npc through the UI and land on its page. */
async function createNpc(page: Page, name: string): Promise<void> {
  await openNpcList(page)
  await page.getByLabel('Name').fill(name)
  await page.getByRole('button', { name: 'Add' }).click()
  await openNpc(page, name)
}

/** Open an existing npc by name. */
async function openNpc(page: Page, name: string): Promise<void> {
  await openNpcList(page)
  await page.getByRole('link', { name, exact: true }).click()
  await expect(page.getByRole('region', { name: 'Relationships' })).toBeVisible()
}

/** Assert a relationship from the entity currently open. */
async function addRelationship(page: Page, type: string, target: string): Promise<void> {
  await page.getByLabel('Relationship', { exact: true }).selectOption({ label: type })
  await page.getByLabel('Relationship target').selectOption({ label: target })
  await page.getByRole('button', { name: 'Add relationship' }).click()
}

test('a DM types a relationship and it reads correctly from BOTH entities', async ({ page }) => {
  await login(page, 'owner')
  await createNpc(page, 'Ally Source')
  await addRelationship(page, 'Ally of', RESTRICTED_NPC.name)

  await expect(relationshipRows(page).getByText('Ally of')).toBeVisible()

  // The other entity's page shows the same row from its own end.
  await relationshipRows(page).getByRole('link', { name: RESTRICTED_NPC.name }).click()
  await expect(page.getByLabel('Name')).toHaveValue(RESTRICTED_NPC.name)
  const row = relationshipRows(page).filter({ hasText: 'Ally Source' })
  await expect(row.getByText('Ally of')).toBeVisible()
})

test('a directional relationship shows its INVERSE on the far entity', async ({ page }) => {
  await login(page, 'owner')
  await createNpc(page, 'Parent Source')
  await addRelationship(page, 'Parent of', RESTRICTED_NPC.name)
  await expect(relationshipRows(page).getByText('Parent of')).toBeVisible()

  await relationshipRows(page).getByRole('link', { name: RESTRICTED_NPC.name }).click()
  await expect(page.getByLabel('Name')).toHaveValue(RESTRICTED_NPC.name)

  // One row, two renderings — the far page cannot describe it the same way.
  const row = relationshipRows(page).filter({ hasText: 'Parent Source' })
  await expect(row.getByText('Child of')).toBeVisible()
  await expect(row.getByText('Parent of')).toHaveCount(0)
})

test('a relationship and a bracket mention sit in separate, labelled groups', async ({ page }) => {
  // Both are true at once. Typing a relationship does not consume the mention.
  await login(page, 'owner')
  await createNpc(page, 'Both Ways')

  await page
    .getByLabel('Description', { exact: true })
    .fill(`Last seen with [[${RESTRICTED_NPC.name}]].`)
  await addRelationship(page, 'Enemy of', RESTRICTED_NPC.name)

  await expect(
    relationshipRows(page).getByRole('link', { name: RESTRICTED_NPC.name }),
  ).toBeVisible()
  await expect(
    page
      .getByRole('region', { name: 'Mentioned in this entry' })
      .getByRole('link', { name: RESTRICTED_NPC.name }),
  ).toBeVisible()
})

test('removing a relationship removes it from both entities', async ({ page }) => {
  await login(page, 'owner')
  await createNpc(page, 'Rival Source')
  await addRelationship(page, 'Rival of', RESTRICTED_NPC.name)
  await expect(relationshipRows(page).getByText('Rival of')).toBeVisible()

  await page.getByRole('button', { name: `Remove Rival of ${RESTRICTED_NPC.name}` }).click()
  await expect(relationshipRows(page).getByText('Rival of')).toHaveCount(0)

  // One row cannot be half-deleted — which is why it is one row.
  await openNpc(page, RESTRICTED_NPC.name)
  await expect(relationshipRows(page).getByRole('link', { name: 'Rival Source' })).toHaveCount(0)
})

test('a player is shown relationships but offered no way to change one', async ({ page }) => {
  await login(page, 'owner')
  await createNpc(page, 'Player Visible')
  await addRelationship(page, 'Serves', RESTRICTED_NPC.name)
  await expect(relationshipRows(page).getByText('Serves')).toBeVisible()

  // player1 IS granted the restricted npc, so both endpoints resolve for them.
  await logout(page)
  await login(page, 'player1')
  await openNpc(page, 'Player Visible')

  await expect(relationshipRows(page).getByText('Serves')).toBeVisible()
  await expect(page.getByLabel('Relationship', { exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: /^Remove Serves/ })).toHaveCount(0)
})

test('a relationship naming an entity the player cannot see is absent entirely', async ({
  page,
}) => {
  // The load-bearing one. The entity being READ is public; its far end is not.
  await login(page, 'owner')
  await createNpc(page, 'Leaky Source')
  await addRelationship(page, 'Member of', RESTRICTED_NPC.name)
  await expect(relationshipRows(page).getByText('Member of')).toBeVisible()

  // player2 holds no grant for the restricted npc.
  await logout(page)
  await login(page, 'player2')
  await openNpc(page, 'Leaky Source')

  await expect(page.getByText('No relationships recorded.')).toBeVisible()
  // Not a typed row with the name blanked out — the name is nowhere on the page.
  expect(await page.content()).not.toContain(RESTRICTED_NPC.name)
})
