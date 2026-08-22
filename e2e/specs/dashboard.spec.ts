import { type Page, expect, test } from '@playwright/test'
import { login } from '../fixtures'
import { ACCOUNTS, SEED_NPC, SEED_PC, SEED_SESSION, WORLD } from '../seed-data'

/**
 * The world root is the dashboard, and it reads differently for the two roles.
 *
 * That difference is load-bearing rather than cosmetic: chain 470 dropped the
 * persistent role badge on the argument that this screen carries the role
 * signal instead. If the GM and the player ever saw the same dashboard, the
 * app would have no place at all that states which one you are.
 */

/**
 * Point the seeded character at a player, or at nobody.
 *
 * Goes through the API as the owner, the way pc-player-link.spec.ts does, and
 * for the same reason: the e2e database is seeded once for the whole run and
 * the world holds exactly two players, so a spec that leaves a seat claimed
 * makes the NEXT spec fail for a reason unrelated to what it checks. This spec
 * therefore claims the seat it needs and releases it again, rather than relying
 * on the seed to hold a link nobody else may disturb.
 */
async function setSeededPcPlayer(page: Page, username: string | null): Promise<void> {
  await page.request.post('/api/login', {
    data: { username: ACCOUNTS.owner.username, password: ACCOUNTS.owner.password },
  })
  const worlds = await page.request.get('/api/worlds')
  const slug = ((await worlds.json()).worlds as { name: string; slug: string }[]).find(
    (w) => w.name === WORLD.name,
  )?.slug
  if (!slug) throw new Error(`no world named ${WORLD.name}`)

  let accountId: string | null = null
  if (username !== null) {
    const members = await page.request.get(`/api/worlds/${slug}/members`)
    accountId =
      ((await members.json()).members as { accountId: string; username: string }[]).find(
        (m) => m.username === username,
      )?.accountId ?? null
    if (accountId === null) throw new Error(`no member named ${username}`)
  }

  const list = await page.request.get(`/api/worlds/${slug}/entities/pc`)
  const pcs = (await list.json()).entities as { id: string; name: string }[]
  const pc = pcs.find((p) => p.name === SEED_PC.name)
  if (!pc) throw new Error(`no character named ${SEED_PC.name}`)
  await page.request.patch(`/api/worlds/${slug}/entities/pc/${pc.id}`, {
    data: { account_id: accountId },
  })
}

test.afterEach(async ({ page }) => {
  await setSeededPcPlayer(page, null)
})

/** Open the seeded world and return its path. */
async function openWorld(page: Page): Promise<string> {
  await page.getByRole('link', { name: WORLD.name }).click()
  await expect(page).toHaveURL(/\/worlds\/[^/]+$/)
  return new URL(page.url()).pathname
}

test('the GM lands on a dashboard: role, the session they last touched, the party', async ({
  page,
}) => {
  await setSeededPcPlayer(page, ACCOUNTS.player1.username)
  await login(page, 'owner')
  await openWorld(page)

  await expect(page.getByLabel('Your role')).toContainText('You write this world')
  const session = page.getByLabel('Where you left off')
  await expect(session.getByRole('link', { name: SEED_SESSION.name })).toBeVisible()
  // The touched entity is a quick-select into its page, not just a name.
  await expect(session.getByRole('link', { name: new RegExp(SEED_NPC.name) })).toBeVisible()
  // The panel never claims to be "the last session" — the ordering falls back
  // to updated_at, so an edit to an older session would promote it. It says
  // which rule placed the row instead.
  await expect(session).not.toContainText('Last session')
  await expect(session).toContainText('most recent in-world date')

  const party = page.getByLabel('The party')
  await expect(party.getByRole('link', { name: SEED_PC.name })).toBeVisible()
})

test('a player lands on their own character first, and is offered no party', async ({ page }) => {
  await setSeededPcPlayer(page, ACCOUNTS.player1.username)
  await login(page, 'player1')
  await openWorld(page)

  await expect(page.getByLabel('Your role')).toContainText('keep notes only you can write')
  await expect(page.getByLabel('Your character')).toContainText(SEED_PC.name)
  await expect(page.getByLabel('The party')).toHaveCount(0)
  // The session panel is there for both roles — it is the ORDER that differs.
  await expect(page.getByLabel('Where you left off')).toContainText(SEED_SESSION.name)
})

test('a player with no character is told what happens next, not shown a blank', async ({
  page,
}) => {
  await login(page, 'player2')
  await openWorld(page)

  await expect(page.getByLabel('Your character')).toContainText('No character linked to you yet')
})

test('the wiki index lives at /wiki, and both it and the dashboard are rail links', async ({
  page,
}) => {
  await login(page, 'owner')
  const worldPath = await openWorld(page)
  const rail = page.getByRole('navigation', { name: 'World sections' })

  await rail.getByRole('link', { name: 'Wiki' }).click()
  await expect(page).toHaveURL(`${worldPath}/wiki`)
  await expect(page.getByRole('heading', { name: 'Wiki' })).toBeVisible()

  await rail.getByRole('link', { name: 'Dashboard' }).click()
  await expect(page).toHaveURL(worldPath)
  await expect(page.getByLabel('Your role')).toBeVisible()
})

test('Maps is a Primary kind in the rail and a quick link on the dashboard', async ({ page }) => {
  await login(page, 'owner')
  const worldPath = await openWorld(page)

  // One shared array feeds both, so Maps appears in both places or neither.
  const jump = page.getByLabel('Jump to')
  // The count is asserted as a NUMBER, not a value: the suite runs sequentially
  // against one database and earlier specs create entities, so pinning an exact
  // count here would make this spec fail whenever another one grew.
  await expect(jump.getByRole('link', { name: /NPCs/ })).toHaveText(/^NPCs\d+$/)
  await jump.getByRole('link', { name: /Maps/ }).click()
  await expect(page).toHaveURL(`${worldPath}/maps`)

  await page.goBack()
  await page
    .getByRole('navigation', { name: 'World sections' })
    .getByRole('link', { name: 'Maps', exact: true })
    .click()
  await expect(page).toHaveURL(`${worldPath}/maps`)
})
