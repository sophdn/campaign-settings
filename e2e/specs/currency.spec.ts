import { expect, type Locator, type Page, test } from '@playwright/test'
import { login } from '../fixtures'
import { WORLD } from '../seed-data'

/**
 * The currency panel, end to end.
 *
 * Restored after bug 1221. This spec was pulled from PR #57 because it appeared
 * to be fighting the test harness: the panel locator matched more than one
 * element and the failures read like locator semantics. It was not the harness.
 * The built SPA really did render two-to-four
 * `section[aria-label="Currency"]` siblings, all but the last inert, because the
 * panel was mounted as `<CurrencyPanel key={entity.id}>`. The first test below is
 * the regression guard for that; the rest are the claims only a browser can make.
 *
 * WHAT ONLY A BROWSER COVERS HERE. The component tests mock the API, so two
 * things never get exercised by them: a denominations array surviving a real
 * round trip through a Postgres `jsonb` column, and the server's cycle refusal
 * actually reaching the page as a message with nothing written behind it.
 *
 * Each test makes its OWN currencies with unique names. The e2e database is
 * seeded once for the whole run and the specs share it, so reusing names would
 * make later assertions depend on earlier tests.
 */

const panel = (page: Page): Locator => page.getByRole('region', { name: 'Currency' })

/**
 * Click Save and wait for the PATCH itself, not for a message on the page.
 *
 * A successful save calls the detail page's `reload()`, which drops the entity
 * back to loading and remounts this panel — so the panel's own "Saved" status is
 * genuinely transient and racing it makes a flaky test. The response is the
 * durable signal. Returns the status code so a caller can assert a REFUSAL too.
 */
async function save(page: Page): Promise<number> {
  const patch = page.waitForResponse(
    (r) =>
      r.request().method() === 'PATCH' && /\/entities\/currency\//.test(new URL(r.url()).pathname),
  )
  await panel(page).getByRole('button', { name: 'Save currency' }).click()
  return (await patch).status()
}

async function openKindList(page: Page, kind: string): Promise<void> {
  await page.goto('/')
  await page.getByRole('link', { name: WORLD.name }).click()
  await expect(page).toHaveURL(/\/worlds\/[^/]+$/)
  await page.goto(`${new URL(page.url()).pathname}/${kind}`)
}

/** Create a currency through the UI and leave the browser on its detail page. */
async function createCurrency(page: Page, name: string): Promise<void> {
  await openKindList(page, 'currency')
  await page.getByLabel('Name').fill(name)
  await page.getByRole('button', { name: 'Add' }).click()
  await openCurrency(page, name)
}

async function openCurrency(page: Page, name: string): Promise<void> {
  await openKindList(page, 'currency')
  await page.getByRole('link', { name, exact: true }).click()
  await expect(panel(page)).toBeVisible()
}

test('exactly ONE currency panel renders, and it is the live one', async ({ page }) => {
  // The bug-1221 regression guard, and the reason it is an e2e test: the
  // duplication never reproduced in jsdom. `toHaveCount(1)` is the whole point —
  // scoping the locator harder would hide exactly the defect this asserts.
  await login(page, 'owner')
  await createCurrency(page, 'Solo Guilder')
  await expect(panel(page)).toHaveCount(1)

  // Client-side navigation away and back was what grew the count.
  for (let i = 0; i < 3; i++) {
    await openCurrency(page, 'Solo Guilder')
    await expect(panel(page)).toHaveCount(1)
  }

  // …and the one on the page responds, rather than being inert leftover DOM.
  await panel(page).getByRole('button', { name: 'Add denomination' }).click()
  await expect(panel(page).getByLabel('Denomination 1 name')).toBeVisible()
})

test('denominations survive a real save and reload through Postgres jsonb', async ({ page }) => {
  await login(page, 'owner')
  await createCurrency(page, 'Round Trip Crown')

  await panel(page).getByRole('button', { name: 'Add denomination' }).click()
  await panel(page).getByLabel('Denomination 1 name').fill('penny')
  await panel(page).getByLabel('Denomination 1 multiplier').fill('0.01')
  await panel(page).getByRole('button', { name: 'Add denomination' }).click()
  await panel(page).getByLabel('Denomination 2 name').fill('shilling')
  await panel(page).getByLabel('Denomination 2 multiplier').fill('0.5')
  expect(await save(page)).toBe(200)

  // A full reload, so the values come back out of the column rather than out of
  // React state — the jsonb array is the part the mocked component tests cannot
  // reach, and an array is also the shape node-pg most easily mangles.
  await page.reload()
  await expect(panel(page).getByLabel('Denomination 1 name')).toHaveValue('penny')
  await expect(panel(page).getByLabel('Denomination 1 multiplier')).toHaveValue('0.01')
  await expect(panel(page).getByLabel('Denomination 2 name')).toHaveValue('shilling')
  await expect(panel(page).getByLabel('Denomination 2 multiplier')).toHaveValue('0.5')
})

test('the server refuses an exchange cycle, the page says so, and nothing is written', async ({
  page,
}) => {
  await login(page, 'owner')
  await createCurrency(page, 'Cycle Alpha')
  await createCurrency(page, 'Cycle Beta')

  // Beta is quoted against Alpha. Legal.
  await panel(page).getByLabel('Base currency').selectOption({ label: 'Cycle Alpha' })
  await panel(page).getByLabel('Rate').fill('2')
  expect(await save(page)).toBe(200)

  // Now quote Alpha against Beta, which closes the loop. The rule lives in
  // `shared/currency-rules` and the SERVER enforces it; what this asserts is that
  // its refusal arrives as a sentence on the page instead of a silent no-op.
  await openCurrency(page, 'Cycle Alpha')
  await panel(page).getByLabel('Base currency').selectOption({ label: 'Cycle Beta' })
  await panel(page).getByLabel('Rate').fill('3')
  // The server refuses it, so this is a 4xx and the panel keeps its state (no
  // reload), which is exactly why the message is assertable here and 'Saved' is not.
  expect(await save(page)).toBeGreaterThanOrEqual(400)

  const alert = panel(page).getByRole('alert')
  await expect(alert).toBeVisible()
  await expect(alert).not.toHaveText('')

  // And the refusal was total: after a reload Alpha still has no anchor.
  await page.reload()
  await expect(panel(page).getByLabel('Base currency')).toHaveValue('')
})

test('a currency is never offered as its own anchor', async ({ page }) => {
  await login(page, 'owner')
  await createCurrency(page, 'Self Anchor Test')

  const options = await panel(page).locator('select option').allTextContents()
  expect(options).toContain('— None —')
  expect(options).not.toContain('Self Anchor Test')
})
