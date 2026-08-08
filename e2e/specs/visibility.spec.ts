import { type Page, expect, test } from '@playwright/test'
import { login, logout } from '../fixtures'
import { ACCOUNTS, LINKED_NPC, RESTRICTED_NPC, SEED_NPC, STAGED_PASSAGE, WORLD } from '../seed-data'

/** Open the seeded world and navigate to its NPC list; returns the world root path. */
async function openWorldNpcList(page: Page): Promise<string> {
  await page.getByRole('link', { name: WORLD.name }).click()
  await expect(page).toHaveURL(/\/worlds\/[^/]+$/)
  const worldPath = new URL(page.url()).pathname
  await page.goto(`${worldPath}/npc`)
  // list has loaded once the public fixture npc is on screen
  await expect(page.getByRole('link', { name: SEED_NPC.name })).toBeVisible()
  return worldPath
}

test('an ungranted player sees neither the restricted entity in the list nor the wiki', async ({
  page,
}) => {
  await login(page, 'player2')
  const worldPath = await openWorldNpcList(page)

  // not in the entity list
  await expect(page.getByRole('link', { name: RESTRICTED_NPC.name })).toHaveCount(0)

  // not in the wiki index either (loaded once the public npc shows)
  await page.goto(worldPath)
  await expect(page.getByRole('link', { name: SEED_NPC.name })).toBeVisible()
  await expect(page.getByRole('link', { name: RESTRICTED_NPC.name })).toHaveCount(0)
})

test('a granted player sees the restricted entity', async ({ page }) => {
  await login(page, 'player1')
  await openWorldNpcList(page)
  await expect(page.getByRole('link', { name: RESTRICTED_NPC.name })).toBeVisible()
})

test('the owner always sees the restricted entity', async ({ page }) => {
  await login(page, 'owner')
  await openWorldNpcList(page)
  await expect(page.getByRole('link', { name: RESTRICTED_NPC.name })).toBeVisible()
})

/**
 * The grant UI end to end: the owner grants player2 (who is seeded WITHOUT a
 * grant) through the entity page, player2 then sees the restricted entity, the
 * owner revokes, and it disappears again. The revoke half is the assertion that
 * matters — a green grant path with no revoke proves only half the ACL.
 */
test('the owner grants and revokes a player through the entity page', async ({ page }) => {
  const player = ACCOUNTS.player2.username

  await login(page, 'owner')
  await openWorldNpcList(page)
  await page.getByRole('link', { name: RESTRICTED_NPC.name }).click()

  const panel = page.getByLabel('Who can see this')
  await expect(panel.getByLabel('Visibility')).toHaveValue('restricted')
  await panel.getByRole('button', { name: `Grant ${player}` }).click()
  await expect(panel.getByRole('button', { name: `Revoke ${player}` })).toBeVisible()

  // the grant is real, not just rendered
  await logout(page)
  await login(page, 'player2')
  await openWorldNpcList(page)
  await expect(page.getByRole('link', { name: RESTRICTED_NPC.name })).toBeVisible()

  // ── revoke ──
  await logout(page)
  await login(page, 'owner')
  await openWorldNpcList(page)
  await page.getByRole('link', { name: RESTRICTED_NPC.name }).click()
  await page
    .getByLabel('Who can see this')
    .getByRole('button', { name: `Revoke ${player}` })
    .click()
  await expect(
    page.getByLabel('Who can see this').getByRole('button', { name: `Grant ${player}` }),
  ).toBeVisible()

  await logout(page)
  await login(page, 'player2')
  await openWorldNpcList(page)
  await expect(page.getByRole('link', { name: RESTRICTED_NPC.name })).toHaveCount(0)
})

test('a player is offered no visibility control at all', async ({ page }) => {
  await login(page, 'player1')
  await openWorldNpcList(page)
  await page.getByRole('link', { name: RESTRICTED_NPC.name }).click()

  await expect(page.getByLabel('Who can see this')).toHaveCount(0)
  await expect(page.getByLabel('Visibility')).toHaveCount(0)
})

/** The graph is a view of the wiki page, not its own route — toggle into it. */
async function openGraph(page: Page, worldPath: string): Promise<void> {
  await page.goto(worldPath)
  await page.getByRole('button', { name: 'Graph', exact: true }).click()
  await expect(page.getByRole('img', { name: 'Entity relationship graph' })).toBeVisible()
}

/**
 * Staged reveal, end to end.
 *
 * The fixture is deliberately built so the pre-existing both-endpoints rule
 * cannot account for the result: BOTH entities are public, so both nodes are on
 * everyone's graph. What is restricted is the passage joining them. player1
 * holds the grant; player2 does not.
 */
test('a restricted passage reveals prose and a graph link to the granted player only', async ({
  page,
}) => {
  const openSeedNpc = async (): Promise<string> => {
    const worldPath = await openWorldNpcList(page)
    await page.getByRole('link', { name: SEED_NPC.name }).click()
    await expect(page.getByRole('heading', { name: SEED_NPC.name })).toBeVisible()
    return worldPath
  }

  // — the granted player reads the reveal —
  await login(page, 'player1')
  let worldPath = await openSeedNpc()
  await expect(page.getByText(STAGED_PASSAGE.phrase)).toBeVisible()
  // the mention it contains is listed as something this page links to
  await expect(page.getByRole('link', { name: LINKED_NPC.name }).first()).toBeVisible()

  await openGraph(page, worldPath)
  await expect(page.getByRole('button', { name: SEED_NPC.name })).toBeVisible()
  await expect(page.getByRole('button', { name: LINKED_NPC.name })).toBeVisible()
  const grantedEdges = await page.locator('svg line').count()
  await logout(page)

  // — the ungranted player sees the same two entities and no connection —
  await login(page, 'player2')
  worldPath = await openSeedNpc()
  await expect(page.getByText(STAGED_PASSAGE.phrase)).toHaveCount(0)

  await openGraph(page, worldPath)
  // both NODES are still there — the entities are public and hiding them would
  // be a different bug
  await expect(page.getByRole('button', { name: SEED_NPC.name })).toBeVisible()
  await expect(page.getByRole('button', { name: LINKED_NPC.name })).toBeVisible()
  // ...but strictly fewer edges, because the link lived in the hidden passage
  expect(await page.locator('svg line').count()).toBeLessThan(grantedEdges)
})
