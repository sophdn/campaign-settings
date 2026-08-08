import { type Page, expect, test } from '@playwright/test'
import { login, logout } from '../fixtures'
import { SEED_NPC, WORLD } from '../seed-data'

/**
 * Authoring staged reveals, as the DM.
 *
 * The visibility.spec.ts sibling proves what a PLAYER can and cannot see once a
 * reveal exists. This one drives the surface that creates them, and asserts the
 * thing that surface must never get wrong: a new reveal starts hidden.
 */

/**
 * Open the seeded public NPC's page and return the world root path.
 *
 * Deliberately does NOT wait on a heading: an owner gets the editor form, where
 * the name is a text FIELD, while a player gets the read-only view with an
 * `h2`. Waiting on the entity URL is the one signal both roles share.
 */
async function openSeedNpc(page: Page): Promise<string> {
  await page.getByRole('link', { name: WORLD.name }).click()
  await expect(page).toHaveURL(/\/worlds\/[^/]+$/)
  const worldPath = new URL(page.url()).pathname
  await page.goto(`${worldPath}/npc`)
  await page.getByRole('link', { name: SEED_NPC.name }).click()
  await expect(page).toHaveURL(/\/worlds\/[^/]+\/npc\/[^/]+$/)
  return worldPath
}

/**
 * Locating a reveal, and why both halves of this matter.
 *
 * EXACT, because Playwright's getByLabel matches by substring and each row has
 * both a `Reveal <label>` textarea and a `Reveal <label> visibility` select.
 *
 * SCOPED to the row, because the page carries several visibility controls at
 * once — the entity's own, plus one per reveal, plus the seeded staged passage
 * this world ships with. Their buttons are named after the PLAYER, not the
 * reveal, so `Revoke e2e-player1` matches every control that has granted them.
 * Asserting on the page found whichever rendered first, which is a race the CI
 * runner lost and this machine won.
 */
const revealField = (page: Page, text: string) => page.getByLabel(`Reveal ${text}`, { exact: true })

const revealRow = (page: Page, text: string) =>
  page.getByRole('listitem').filter({ has: revealField(page, text) })

async function addReveal(page: Page, text: string): Promise<void> {
  await page.getByLabel('New reveal').fill(text)
  await page.getByRole('button', { name: 'Add reveal' }).click()
  await expect(revealField(page, text)).toBeVisible()
}

test('an owner adds, restricts, reorders and deletes a reveal', async ({ page }) => {
  // Stamped per run. A retry re-runs against the database the FAILED attempt
  // already wrote to — Playwright resets the browser, not the world — so fixed
  // names collide with their own leftovers and the retry fails somewhere new.
  const stamp = Date.now()
  const alpha = `Alpha ${stamp}`
  const beta = `Beta ${stamp}`

  await login(page, 'owner')
  await openSeedNpc(page)
  await expect(page.getByRole('heading', { name: 'Reveals' })).toBeVisible()

  // — add two, and confirm a new one is born HIDDEN rather than public —
  await addReveal(page, alpha)
  await expect(page.getByLabel(`Reveal ${alpha} visibility`, { exact: true })).toHaveValue(
    'dm_only',
  )
  await addReveal(page, beta)

  // — reorder: alpha moves below beta —
  const bothFields = () => page.getByLabel(new RegExp(`^Reveal (Alpha|Beta) ${stamp}$`))
  await expect(bothFields()).toHaveCount(2)
  await page.getByRole('button', { name: `Move ${alpha} down` }).click()
  await expect(bothFields().first()).toHaveValue(beta)

  // — restrict alpha to one named player, asserting WITHIN alpha's own row —
  await page
    .getByLabel(`Reveal ${alpha} visibility`, { exact: true })
    .selectOption({ label: 'Only the players you choose' })
  const alphaRow = revealRow(page, alpha)
  await alphaRow.getByRole('button', { name: 'Grant e2e-player1' }).click()
  await expect(alphaRow.getByRole('button', { name: 'Revoke e2e-player1' })).toBeVisible()

  // Regression guard for the bug this test shipped with: the page genuinely
  // carries MORE than one `Revoke e2e-player1` now — this reveal's, and the
  // seeded staged passage's. A page-level locator is therefore ambiguous, not
  // merely fragile, and only passed here by winning a render race.
  expect(await page.getByRole('button', { name: 'Revoke e2e-player1' }).count()).toBeGreaterThan(1)

  // — delete beta, with the confirm step —
  await page.getByRole('button', { name: `Delete ${beta}` }).click()
  await page.getByRole('button', { name: `Really delete ${beta}` }).click()
  await expect(revealField(page, beta)).toHaveCount(0)
  await expect(revealField(page, alpha)).toBeVisible()

  // — and the granted player reads exactly the surviving reveal —
  await logout(page)
  await login(page, 'player1')
  await openSeedNpc(page)
  await expect(page.getByRole('heading', { name: SEED_NPC.name })).toBeVisible()
  await expect(page.getByText(alpha)).toBeVisible()
  await expect(page.getByText(beta)).toHaveCount(0)
})

test('a player is offered no reveal controls at all', async ({ page }) => {
  await login(page, 'player2')
  await openSeedNpc(page)

  // The server refuses every one of these regardless — http-passages.test.ts
  // asserts the 403s. This is about not showing a control that would only fail.
  await expect(page.getByRole('button', { name: 'Add reveal' })).toHaveCount(0)
  await expect(page.getByLabel('New reveal')).toHaveCount(0)
  await expect(page.getByRole('heading', { name: 'Reveals' })).toHaveCount(0)
})

/**
 * A player suggests something, and the GM decides.
 *
 * The suggestion becomes a `proposed` passage that only its author and the GM
 * can see, which is why the second player is checked in the middle rather than
 * only at the end — a proposal visible to the whole party would be the same
 * class of leak this chain exists to prevent.
 */
test('a player proposes, only the GM sees it, and accepting shows it to everyone', async ({
  page,
}) => {
  const suggestion = `Proposal ${Date.now()}`

  await login(page, 'player1')
  await openSeedNpc(page)
  await page.getByLabel('Your suggestion').fill(suggestion)
  await page.getByRole('button', { name: 'Send to GM' }).click()
  // the author reads their own pending suggestion back
  await expect(page.getByText(suggestion)).toBeVisible()
  await logout(page)

  // — a different player sees nothing —
  await login(page, 'player2')
  await openSeedNpc(page)
  await expect(page.getByText(suggestion)).toHaveCount(0)
  await logout(page)

  // — the GM reviews it in place and publishes it to the world —
  await login(page, 'owner')
  await openSeedNpc(page)
  const label = suggestion.slice(0, 40)
  await expect(page.getByRole('region', { name: 'Suggestions awaiting review' })).toBeVisible()
  await page
    .getByLabel(`Publish ${label} as`, { exact: true })
    .selectOption({ label: 'Everyone in the world' })
  await page.getByRole('button', { name: `Accept ${label}` }).click()
  await expect(page.getByRole('region', { name: 'Suggestions awaiting review' })).toHaveCount(0)
  await logout(page)

  // — and now the player who could not see it, can —
  await login(page, 'player2')
  await openSeedNpc(page)
  await expect(page.getByText(suggestion)).toBeVisible()
})

test('a player is offered the suggestion box but none of the GM’s controls', async ({ page }) => {
  await login(page, 'player2')
  await openSeedNpc(page)
  await expect(page.getByLabel('Your suggestion')).toBeVisible()
  await expect(page.getByRole('region', { name: 'Suggestions awaiting review' })).toHaveCount(0)
})
