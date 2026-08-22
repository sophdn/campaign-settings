import { type Page, expect, test } from '@playwright/test'
import { login, logout, openEntityEditor } from '../fixtures'
import { ACCOUNTS, WORLD } from '../seed-data'

/**
 * The PC → player link, end to end.
 *
 * What a browser is needed for, over and above `data/pc-account.test.ts` (which
 * already proves the rules against a real Postgres):
 *
 *  1. The GM's REFUSAL is legible. The one-character-per-player rule is a
 *     partial unique index, and without the guard in front of it a second link
 *     reaches the GM as a 500. Only a real request through the real route shows
 *     what they actually see, and the unit tests deliberately call the guard
 *     directly — so they see the exception class and never the status code.
 *  2. The picker offers PLAYERS, by username. The component test proves that
 *     against a fake member list; this proves the real `/members` response
 *     drives it, which is the part a shape change would break silently.
 *  3. A player reads the link as a name. The account id must never reach the
 *     DOM, and "does not appear anywhere on the rendered page" is a claim only
 *     a rendered page can settle.
 *
 * Every test makes its OWN characters, and RELEASES every seat afterwards. The
 * e2e database is seeded once for the whole run and specs share it, while the
 * world holds exactly two players — so a test that left `player1` holding a
 * character would make the next test's link fail for a reason that has nothing
 * to do with what it was checking. The cleanup is the fixture here, not
 * tidiness: without it these tests pass or fail on declaration order.
 */

async function openWorld(page: Page): Promise<string> {
  await page.goto('/')
  await page.getByRole('link', { name: WORLD.name }).click()
  await expect(page).toHaveURL(/\/worlds\/[^/]+$/)
  return new URL(page.url()).pathname
}

/** Create a PC through the UI and land on its page. */
async function createPc(page: Page, name: string): Promise<void> {
  const base = await openWorld(page)
  await page.goto(`${base}/pc`)
  await page.getByLabel('Name').fill(name)
  await page.getByRole('button', { name: 'Add' }).click()
  await openPc(page, name)
}

async function openPc(page: Page, name: string): Promise<void> {
  const base = await openWorld(page)
  await page.goto(`${base}/pc`)
  await page.getByRole('link', { name, exact: true }).click()
  // The page opens as readable prose now; the "Played by" picker lives in the
  // editor, which the GM has to unfold first. A player has no pencil at all and
  // reads the link off the entry itself — see the player test below.
  await openEntityEditor(page)
  await pickerReady(page)
}

/**
 * Wait for the member list to arrive.
 *
 * The picker renders a single disabled "Loading players…" option until
 * `/members` lands, so reading the selection before then reports the
 * placeholder rather than the stored value — which is a real race a test hits
 * and a human never notices. Waiting on "— Nobody —" waits on the loaded
 * state itself rather than on a duration.
 */
async function pickerReady(page: Page): Promise<void> {
  await expect(page.getByLabel('Played by')).toContainText('— Nobody —')
}

/** The currently selected player, once the picker has actually loaded. */
async function playedBy(page: Page): Promise<string | null> {
  await pickerReady(page)
  return page.getByLabel('Played by').locator('option:checked').textContent()
}

/** Set "Played by" and save, without asserting the outcome either way. */
async function setPlayedBy(page: Page, username: string): Promise<void> {
  await page.getByLabel('Played by').selectOption({ label: username })
  await page.getByRole('button', { name: 'Save' }).click()
}

/**
 * Release every PC in the world, as the owner.
 *
 * Goes through the API rather than the UI: it must run after a test that ended
 * signed in as a PLAYER, who cannot write content, so it re-establishes the
 * owner session first. `page.request` shares the browser context's cookie jar,
 * which is what makes that one POST enough.
 */
async function releaseAllSeats(page: Page): Promise<void> {
  await page.request.post('/api/login', {
    data: { username: ACCOUNTS.owner.username, password: ACCOUNTS.owner.password },
  })
  const worlds = await page.request.get('/api/worlds')
  const slug = ((await worlds.json()).worlds as { name: string; slug: string }[]).find(
    (w) => w.name === WORLD.name,
  )?.slug
  if (!slug) return
  const list = await page.request.get(`/api/worlds/${slug}/entities/pc`)
  const pcs = (await list.json()).entities as { id: string; account_id: string | null }[]
  for (const pc of pcs.filter((p) => p.account_id !== null)) {
    await page.request.patch(`/api/worlds/${slug}/entities/pc/${pc.id}`, {
      data: { account_id: null },
    })
  }
}

test.describe('the PC → player link', () => {
  test.afterEach(async ({ page }) => {
    await releaseAllSeats(page)
  })

  test('the GM links a character to a player, and it survives a reload', async ({ page }) => {
    await login(page, 'owner')
    await createPc(page, 'Link Roland')

    // The picker offers the world's PLAYERS from the live members response —
    // never the GM, who does not play one of the party's characters.
    await pickerReady(page)
    const options = await page.getByLabel('Played by').locator('option').allTextContents()
    expect(options).toContain(ACCOUNTS.player1.username)
    expect(options).toContain(ACCOUNTS.player2.username)
    expect(options).not.toContain(ACCOUNTS.owner.username)
    expect(options).toContain('— Nobody —')

    await setPlayedBy(page, ACCOUNTS.player1.username)
    await expect(page.getByRole('status')).toHaveText('Saved')

    await page.reload()
    await openEntityEditor(page)
    expect(await playedBy(page)).toBe(ACCOUNTS.player1.username)
  })

  test('a second character for the same player is refused, in words', async ({ page }) => {
    await login(page, 'owner')
    await createPc(page, 'Seat Holder')
    await setPlayedBy(page, ACCOUNTS.player2.username)
    await expect(page.getByRole('status')).toHaveText('Saved')

    await createPc(page, 'Seat Claimant')
    await setPlayedBy(page, ACCOUNTS.player2.username)

    // The point of this test: a SENTENCE naming the player and the character
    // already holding the seat — not "Save failed", not a 500, not a raw
    // constraint violation. The guard in data/pc-account.ts exists for exactly
    // this and nothing else asserts it reaches a human.
    const status = page.getByRole('status')
    await expect(status).toContainText(ACCOUNTS.player2.username)
    await expect(status).toContainText('Seat Holder')
    await expect(status).toContainText('already plays')

    // And it did not partially apply: the claimant is still unlinked.
    await page.reload()
    await openEntityEditor(page)
    expect(await playedBy(page)).toBe('— Nobody —')
  })

  test('clearing the first character frees the seat for the second', async ({ page }) => {
    await login(page, 'owner')
    await createPc(page, 'Retiring Hero')
    await setPlayedBy(page, ACCOUNTS.player1.username)
    await expect(page.getByRole('status')).toHaveText('Saved')

    await createPc(page, 'Successor Hero')
    await setPlayedBy(page, ACCOUNTS.player1.username)
    await expect(page.getByRole('status')).toContainText('already plays')

    // Retire the first by clearing its link — its page stays, it just stops
    // claiming the seat.
    await openPc(page, 'Retiring Hero')
    await setPlayedBy(page, '— Nobody —')
    await expect(page.getByRole('status')).toHaveText('Saved')

    await openPc(page, 'Successor Hero')
    await setPlayedBy(page, ACCOUNTS.player1.username)
    await expect(page.getByRole('status')).toHaveText('Saved')

    // The retired character is intact and unclaimed.
    await openPc(page, 'Retiring Hero')
    expect(await playedBy(page)).toBe('— Nobody —')
  })

  test('a player sees the username and never the account id, and cannot edit it', async ({
    page,
  }) => {
    await login(page, 'owner')
    await createPc(page, 'Seen By Player')
    await setPlayedBy(page, ACCOUNTS.player1.username)
    await expect(page.getByRole('status')).toHaveText('Saved')
    const pcUrl = new URL(page.url()).pathname

    await logout(page)
    await login(page, 'player2')
    await page.goto(pcUrl)

    // Read as a labelled row, not a form control: content writes are owner-only
    // and a player is shown no editor at all.
    await expect(page.getByText('Played by')).toBeVisible()
    await expect(page.getByText(ACCOUNTS.player1.username, { exact: true })).toBeVisible()
    await expect(page.getByLabel('Played by')).toHaveCount(0)

    // The account id is a uuid the page has no business rendering. Asserted
    // against the whole document rather than one element, because the failure
    // this guards is an id leaking somewhere nobody was looking.
    const body = await page.locator('body').innerText()
    expect(body).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)
  })
})
