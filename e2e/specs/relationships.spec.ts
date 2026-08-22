import { type Locator, type Page, expect, test } from '@playwright/test'
import { login, logout, openEntityEditor, openPanel } from '../fixtures'
import { RESTRICTED_NPC, SEED_NPC, WORLD } from '../seed-data'

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
 * Open one of the seeded world's kind lists, from wherever the test currently is.
 *
 * Starts at the world picker every time: the world's own link exists only
 * there, so a helper that assumed it was already on the picker would work on
 * its first call and hang on every later one.
 */
async function openKindList(page: Page, kind = 'npc'): Promise<void> {
  await page.goto('/')
  await page.getByRole('link', { name: WORLD.name }).click()
  await expect(page).toHaveURL(/\/worlds\/[^/]+$/)
  await page.goto(`${new URL(page.url()).pathname}/${kind}`)
}

/** Create a fresh entity of `kind` through the UI and land on its page. */
async function createEntity(page: Page, name: string, kind = 'npc'): Promise<void> {
  await openKindList(page, kind)
  await page.getByLabel('Name').fill(name)
  await page.getByRole('button', { name: 'Add' }).click()
  await openEntity(page, name, kind)
}

/**
 * Open an existing entity of `kind` by name, and unfold both reference panels.
 *
 * Relationships and Mentioned-in-this-entry are CLOSED accordions now, because
 * they are secondary to the prose. Every test here is about their contents, so
 * each one presses the fold first rather than reaching past it.
 */
async function openEntity(page: Page, name: string, kind = 'npc'): Promise<void> {
  await openKindList(page, kind)
  await page.getByRole('link', { name, exact: true }).click()
  await openReferencePanels(page, name)
}

/**
 * Wait for `entityName`'s page, then unfold its two reference panels.
 *
 * Called again after every in-page navigation: following a relationship row's
 * link lands on the FAR entity's page, where both panels are closed again. The
 * heading is waited on FIRST, so the panels being opened belong to the page the
 * assertions are about rather than to the one just left.
 */
async function openReferencePanels(page: Page, entityName: string): Promise<void> {
  await expect(page.getByRole('heading', { name: entityName, level: 2 })).toBeVisible()
  await openPanel(page, 'Relationships')
  await openPanel(page, 'Mentioned in this entry')
}

const createNpc = (page: Page, name: string): Promise<void> => createEntity(page, name)
const openNpc = (page: Page, name: string): Promise<void> => openEntity(page, name)

/**
 * Assert a relationship from the entity currently open, optionally with the
 * controlled role that types like `Speaks` accept.
 */
async function addRelationship(
  page: Page,
  type: string,
  target: string,
  role?: string,
): Promise<void> {
  await page.getByLabel('Relationship', { exact: true }).selectOption({ label: type })
  await page.getByLabel('Relationship target').selectOption({ label: target })
  if (role !== undefined) {
    await page.getByLabel('Relationship role').selectOption({ label: role })
  }
  await page.getByRole('button', { name: 'Add relationship' }).click()
}

test('a DM types a relationship and it reads correctly from BOTH entities', async ({ page }) => {
  await login(page, 'owner')
  await createNpc(page, 'Ally Source')
  await addRelationship(page, 'Ally of', RESTRICTED_NPC.name)

  await expect(relationshipRows(page).getByText('Ally of')).toBeVisible()

  // The other entity's page shows the same row from its own end.
  await relationshipRows(page).getByRole('link', { name: RESTRICTED_NPC.name }).click()
  await openReferencePanels(page, RESTRICTED_NPC.name)
  const row = relationshipRows(page).filter({ hasText: 'Ally Source' })
  await expect(row.getByText('Ally of')).toBeVisible()
})

test('a directional relationship shows its INVERSE on the far entity', async ({ page }) => {
  await login(page, 'owner')
  await createNpc(page, 'Parent Source')
  await addRelationship(page, 'Parent of', RESTRICTED_NPC.name)
  await expect(relationshipRows(page).getByText('Parent of')).toBeVisible()

  await relationshipRows(page).getByRole('link', { name: RESTRICTED_NPC.name }).click()
  await openReferencePanels(page, RESTRICTED_NPC.name)

  // One row, two renderings — the far page cannot describe it the same way.
  const row = relationshipRows(page).filter({ hasText: 'Parent Source' })
  await expect(row.getByText('Child of')).toBeVisible()
  await expect(row.getByText('Parent of')).toHaveCount(0)
})

test('a relationship and a bracket mention sit in separate, labelled groups', async ({ page }) => {
  // Both are true at once. Typing a relationship does not consume the mention.
  await login(page, 'owner')
  await createNpc(page, 'Both Ways')

  // The Description field is in the editor, which is collapsed on arrival.
  await openEntityEditor(page)
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

/**
 * The attributive half of the vocabulary — the four types migration 0017 folded in
 * from the dormant junction tables.
 *
 * These are the ones a browser is genuinely needed for. Everything below the API
 * is covered by unit and integration tests; what only a real page can show is that
 * a language ROLE survives the round trip and renders as its own badge, and that
 * the fifteen-type picker is still navigable now that it is grouped.
 */
test('a DM records what an NPC speaks, with a role, and it reads from both ends', async ({
  page,
}) => {
  await login(page, 'owner')
  // Deliberately NOT named after a role: a name containing "liturgical" would
  // make the badge assertion below match the target's own link as well.
  await createEntity(page, 'Old Church Tongue', 'language')
  await createNpc(page, 'Polyglot Prince')

  await addRelationship(page, 'Speaks', 'Old Church Tongue', 'liturgical')

  // The forward reading, with the role beside it rather than folded into the label.
  const row = relationshipRows(page).filter({ hasText: 'Old Church Tongue' })
  await expect(row.getByText('Speaks')).toBeVisible()
  await expect(row.getByText('liturgical', { exact: true })).toBeVisible()

  // The language's own page renders the SAME row through the inverse heading —
  // "Spoken by", which is the heading dm-manager used for this cross-reference.
  await row.getByRole('link', { name: 'Old Church Tongue' }).click()
  await openReferencePanels(page, 'Old Church Tongue')
  const inverse = relationshipRows(page).filter({ hasText: 'Polyglot Prince' })
  await expect(inverse.getByText('Spoken by')).toBeVisible()
  await expect(inverse.getByText('Speaks')).toHaveCount(0)
  // The role belongs to the relationship, not to either end, so it reads on both.
  await expect(inverse.getByText('liturgical', { exact: true })).toBeVisible()
})

test('the reference panels open CLOSED, and are two siblings rather than one wrapper', async ({
  page,
}) => {
  await login(page, 'owner')
  await openKindList(page, 'npc')
  await page.getByRole('link', { name: RESTRICTED_NPC.name, exact: true }).click()
  await expect(page.getByRole('heading', { name: RESTRICTED_NPC.name, level: 2 })).toBeVisible()

  // The wrapper headed "Linked entities" named a category rather than a thing.
  await expect(page.getByRole('region', { name: 'Linked entities' })).toHaveCount(0)

  // Both panels are present and both are folded away: a reader arrives for the
  // prose and answers "what else does this touch" afterwards, or not at all.
  for (const name of ['Type', 'Relationships', 'Mentioned in this entry']) {
    const region = page.getByRole('region', { name })
    await expect(region).toBeVisible()
    await expect(region.locator('details').first()).toHaveJSProperty('open', false)
  }

  // And they open on a press, which is how every other test here reaches them.
  await openPanel(page, 'Relationships')
  await expect(
    page.getByRole('region', { name: 'Relationships' }).locator('details').first(),
  ).toHaveJSProperty('open', true)
})

test('the picker separates social types from attributive ones', async ({ page }) => {
  await login(page, 'owner')
  await createNpc(page, 'Picker Reader')

  const picker = page.getByLabel('Relationship', { exact: true })
  // Grouped, and still fifteen selectable types underneath the two headings.
  await expect(picker.locator('optgroup')).toHaveCount(2)
  await expect(picker.locator('optgroup').nth(0)).toHaveAttribute('label', 'Social & structural')
  await expect(picker.locator('optgroup').nth(1)).toHaveAttribute('label', 'Attributes')
  await expect(picker.locator('option')).toHaveCount(15)
})

test('the role field appears only for a type that accepts one', async ({ page }) => {
  await login(page, 'owner')
  await createNpc(page, 'Role Field Reader')

  const picker = page.getByLabel('Relationship', { exact: true })
  await picker.selectOption({ label: 'Ally of' })
  await expect(page.getByLabel('Relationship role')).toHaveCount(0)

  await picker.selectOption({ label: 'Speaks' })
  await expect(page.getByLabel('Relationship role')).toBeVisible()

  // Practises is attributive too but defines no vocabulary, so no field for it.
  await picker.selectOption({ label: 'Practises' })
  await expect(page.getByLabel('Relationship role')).toHaveCount(0)
})

/**
 * The bracket → relationship round trip, in a browser.
 *
 * The server suites prove reconciliation and the derived-visibility rule
 * against a real Postgres. What a browser adds is the part that depends on one:
 * an author writes a link, saves, and the relationship is there on the page and
 * in the graph — without ever opening the relationship form.
 */
/** The graph is a view of the wiki page, not its own route — toggle into it. */
async function openGraph(page: Page, worldPath: string): Promise<void> {
  await page.goto(`${worldPath}/wiki`)
  await page.getByRole('button', { name: 'Graph', exact: true }).click()
  await expect(page.getByRole('img', { name: 'Entity relationship graph' })).toBeVisible()
}

test('writing a bracket creates a relationship, and removing it retires the row', async ({
  page,
}) => {
  await login(page, 'owner')
  const name = `Bracket Source ${Date.now()}`
  await createNpc(page, name)
  const worldPath = `/worlds/${new URL(page.url()).pathname.split('/')[2]}`

  await openEntityEditor(page)
  await page.getByLabel('Description', { exact: true }).fill(`Owes [[${SEED_NPC.name}]] a favour.`)
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByText('Saved', { exact: true })).toBeVisible()

  // No relationship form was touched: the link IS the relationship now.
  await page.reload()
  await openReferencePanels(page, name)
  const row = relationshipRows(page).filter({ hasText: SEED_NPC.name })
  await expect(row.getByText('Related to')).toBeVisible()

  // …and it is an EDGE. Typed relationships were invisible in the graph before
  // chain 470, so the graph and the entity pages disagreed about how connected
  // the world was.
  const selfId = new URL(page.url()).pathname.split('/').pop() as string
  const targetId = (await row.getByRole('link', { name: SEED_NPC.name }).getAttribute('href'))
    ?.split('/')
    .pop() as string
  await openGraph(page, worldPath)
  await expect(page.locator(`[data-edge="relationship:${selfId}:${targetId}"]`)).toHaveCount(1)

  // Remove the bracket and the row goes with it — it carried nothing the
  // bracket did not.
  await page.goto(`${worldPath}/npc`)
  await page.getByRole('link', { name, exact: true }).click()
  await openEntityEditor(page)
  await page.getByLabel('Description', { exact: true }).fill('Owes nobody anything.')
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByText('Saved', { exact: true })).toBeVisible()

  await page.reload()
  await openReferencePanels(page, name)
  await expect(relationshipRows(page).filter({ hasText: SEED_NPC.name })).toHaveCount(0)

  // The edge goes with it, by the same route it arrived.
  await openGraph(page, worldPath)
  await expect(page.locator(`[data-edge="relationship:${selfId}:${targetId}"]`)).toHaveCount(0)
})

test('specifying a derived row keeps it when the bracket goes', async ({ page }) => {
  await login(page, 'owner')
  const name = `Specified Source ${Date.now()}`
  await createNpc(page, name)

  await openEntityEditor(page)
  await page.getByLabel('Description', { exact: true }).fill(`Drinks with [[${SEED_NPC.name}]].`)
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByText('Saved', { exact: true })).toBeVisible()

  await page.reload()
  await openReferencePanels(page, name)
  // Specified IN PLACE. Deleting and retyping would lose the row's source, and
  // for a link written inside a reveal that would publish the secret.
  await page.getByRole('button', { name: `Specify Related to ${SEED_NPC.name}` }).click()
  await page.getByLabel('New relationship type').selectOption({ label: 'Ally of' })
  await page.getByRole('button', { name: 'Save relationship' }).click()
  await expect(
    relationshipRows(page).filter({ hasText: SEED_NPC.name }).getByText('Ally of'),
  ).toBeVisible()

  await openEntityEditor(page)
  await page.getByLabel('Description', { exact: true }).fill('Drinks alone.')
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByText('Saved', { exact: true })).toBeVisible()

  await page.reload()
  await openReferencePanels(page, name)
  await expect(
    relationshipRows(page).filter({ hasText: SEED_NPC.name }).getByText('Ally of'),
  ).toBeVisible()
})
