import { expect, type Locator, type Page, test } from '@playwright/test'
import { login, logout } from '../fixtures'
import { WORLD } from '../seed-data'

/**
 * A settlement's and an organization's currencies, end to end.
 *
 * WHAT ONLY A BROWSER COVERS HERE. The component tests mock the API, so three
 * things never get exercised by them: the ONE panel actually mounting on both
 * owner kinds through the real detail route, the primary swap surviving a real
 * transaction (the demote and the promote are two statements against a unique
 * index that would refuse them in the wrong order), and a player's read being
 * filtered by the server rather than by the component.
 *
 * The panel is NOT keyed at its render site, for the reason bug 1221 established
 * on the currency panel — a `key` there left two-to-four inert duplicate panels
 * on the built SPA, and only a browser reproduced it. The first test is that
 * regression guard for this panel.
 *
 * No assertion here waits on a transient "Saved" status. Every write reloads the
 * list and remounts the row, so a status message races its own unmount; the specs
 * key off the RESPONSE or off what the reloaded list shows. Also from bug 1221.
 *
 * Each test makes its OWN entities with unique names. The e2e database is seeded
 * once for the whole run and the specs share it, so reusing names would make
 * later assertions depend on earlier tests.
 */

const panel = (page: Page): Locator => page.getByRole('region', { name: 'Currencies' })
const usedBy = (page: Page): Locator => page.getByRole('region', { name: 'Used by' })

async function openKindList(page: Page, kind: string): Promise<void> {
  await page.goto('/')
  await page.getByRole('link', { name: WORLD.name }).click()
  await expect(page).toHaveURL(/\/worlds\/[^/]+$/)
  await page.goto(`${new URL(page.url()).pathname}/${kind}`)
}

/** Create an entity of `kind` through the UI and open its detail page. */
async function create(page: Page, kind: string, name: string): Promise<void> {
  await openKindList(page, kind)
  await page.getByLabel('Name').fill(name)
  await page.getByRole('button', { name: 'Add' }).click()
  await open(page, kind, name)
}

/**
 * Open an entity's detail page from its kind list.
 *
 * Landing is asserted on the URL rather than on a heading with the entity's
 * name: an OWNER gets the editor rather than the read view, and the read view is
 * where that heading lives. A URL assertion is true for both roles and for every
 * kind, which is what this helper is used across.
 */
async function open(page: Page, kind: string, name: string): Promise<void> {
  await openKindList(page, kind)
  await page.getByRole('link', { name, exact: true }).click()
  await expect(page).toHaveURL(/\/worlds\/[^/]+\/[^/]+\/[^/]+$/)
}

/**
 * Attach a currency and wait for the POST itself.
 *
 * The response is the durable signal: the success path reloads the list, so
 * anything transient the panel rendered is already gone by the time an assertion
 * could look for it.
 */
async function attach(page: Page, currencyName: string): Promise<number> {
  const post = page.waitForResponse(
    (r) => r.request().method() === 'POST' && /\/currencies$/.test(new URL(r.url()).pathname),
  )
  await panel(page).getByLabel('Attach a currency').selectOption({ label: currencyName })
  await panel(page).getByRole('button', { name: 'Attach' }).click()
  return (await post).status()
}

/**
 * Set the visibility of the ENTITY the page is on, via its own panel.
 *
 * Waits for the PATCH rather than for the select's value: the control writes
 * through to the server and a value assertion would pass on optimistic state.
 */
async function setEntityVisibility(page: Page, level: string): Promise<void> {
  const patch = page.waitForResponse(
    (r) => r.request().method() === 'PATCH' && /\/entities\//.test(new URL(r.url()).pathname),
  )
  await page.getByLabel('Who can see this').getByLabel('Visibility').selectOption(level)
  expect((await patch).status()).toBe(200)
}

/** Click a row control and wait for the PATCH/DELETE behind it. */
async function act(page: Page, buttonName: string, method: 'PATCH' | 'DELETE'): Promise<number> {
  const res = page.waitForResponse(
    (r) =>
      r.request().method() === method && /\/currency-attachments\//.test(new URL(r.url()).pathname),
  )
  await panel(page).getByRole('button', { name: buttonName }).click()
  return (await res).status()
}

test('exactly ONE currencies panel renders, on both owner kinds, and it is live', async ({
  page,
}) => {
  // The bug-1221 regression guard for this panel. `toHaveCount(1)` is the point —
  // scoping the locator harder would hide exactly the defect this asserts, and
  // the duplication never reproduced in jsdom.
  await login(page, 'owner')
  await create(page, 'currency', 'Panel Count Mark')

  for (const [kind, name] of [
    ['settlement', 'Panel Count Hold'],
    ['organization', 'Panel Count Guild'],
  ] as const) {
    await create(page, kind, name)
    await expect(panel(page)).toHaveCount(1)

    // Client-side navigation away and back is what grew the count on the SPA.
    for (let i = 0; i < 3; i++) {
      await open(page, kind, name)
      await expect(panel(page)).toHaveCount(1)
    }

    // …and the one on the page responds, rather than being inert leftover DOM.
    expect(await attach(page, 'Panel Count Mark')).toBe(201)
    await expect(panel(page).getByRole('link', { name: 'Panel Count Mark' })).toBeVisible()
  }
})

test('attach, set primary, and detach — through a real transaction', async ({ page }) => {
  await login(page, 'owner')
  await create(page, 'currency', 'Swap Mark')
  await create(page, 'currency', 'Swap Crown')
  await create(page, 'settlement', 'Swap Hold')

  expect(await attach(page, 'Swap Mark')).toBe(201)
  expect(await attach(page, 'Swap Crown')).toBe(201)

  // Promotion is a demote + a promote against `<table>_one_primary`, a unique
  // index that refuses the pair in the wrong order. Only a real database says
  // whether the transaction actually holds.
  // EXACT, on every 'Primary' below. The badge reads "Primary"; the control that
  // promotes a row reads "Make primary", and `getByText` is substring AND
  // case-insensitive — so the loose locator matches BOTH states of a row and is
  // never 0 once the list has settled. `toHaveCount(0)` below could then only
  // pass by catching the reload's unmount window, which is a race it won on this
  // machine and lost on CI. Exact tells the badge from the button.
  expect(await act(page, 'Make Swap Mark primary', 'PATCH')).toBe(200)
  const mark = panel(page).getByRole('listitem').filter({ hasText: 'Swap Mark' })
  await expect(mark.getByText('Primary', { exact: true })).toBeVisible()

  expect(await act(page, 'Make Swap Crown primary', 'PATCH')).toBe(200)
  const crown = panel(page).getByRole('listitem').filter({ hasText: 'Swap Crown' })
  await expect(crown.getByText('Primary', { exact: true })).toBeVisible()
  // The incumbent was demoted by the same transaction, not left as a second
  // primary and not merely hidden by the client.
  await expect(mark.getByText('Primary', { exact: true })).toHaveCount(0)

  await page.reload()
  await expect(
    panel(page)
      .getByRole('listitem')
      .filter({ hasText: 'Swap Crown' })
      .getByText('Primary', { exact: true }),
  ).toBeVisible()

  expect(await act(page, 'Detach Swap Mark', 'DELETE')).toBe(200)
  await page.reload()
  await expect(panel(page).getByRole('link', { name: 'Swap Mark' })).toHaveCount(0)
  await expect(panel(page).getByRole('link', { name: 'Swap Crown' })).toBeVisible()
})

test('the currency page lists who uses it, across both owner kinds', async ({ page }) => {
  await login(page, 'owner')
  await create(page, 'currency', 'Inverse Mark')
  await create(page, 'settlement', 'Inverse Hold')
  expect(await attach(page, 'Inverse Mark')).toBe(201)
  await create(page, 'organization', 'Inverse Guild')
  expect(await attach(page, 'Inverse Mark')).toBe(201)
  expect(await act(page, 'Make Inverse Mark primary', 'PATCH')).toBe(200)

  await open(page, 'currency', 'Inverse Mark')
  await expect(usedBy(page).getByRole('link', { name: 'Inverse Hold' })).toBeVisible()
  const guild = usedBy(page).getByRole('listitem').filter({ hasText: 'Inverse Guild' })
  await expect(guild.getByText('Primary', { exact: true })).toBeVisible()

  // The links go somewhere: following one lands on that owner's page, which is
  // recognisable by its own currencies panel listing the coin we came from.
  await usedBy(page).getByRole('link', { name: 'Inverse Hold' }).click()
  await expect(panel(page).getByRole('link', { name: 'Inverse Mark' })).toBeVisible()
})

test('a player reads what the two visibility rules allow, and is offered no control', async ({
  page,
}) => {
  await login(page, 'owner')
  await create(page, 'currency', 'Player Visible Mark')
  await create(page, 'currency', 'Player Hidden Penny')
  // A dm_only CURRENCY. Its attachment row below stays public, so only the
  // endpoint rule can hide it — the half the seam cannot apply on the row's own
  // behalf.
  await setEntityVisibility(page, 'dm_only')

  await create(page, 'settlement', 'Player Read Hold')
  expect(await attach(page, 'Player Visible Mark')).toBe(201)
  expect(await attach(page, 'Player Hidden Penny')).toBe(201)

  // A dm_only ATTACHMENT of a visible currency — the other half, failing on its
  // own: the currency is public and resolves fine, so only the row's own
  // visibility can drop it.
  await create(page, 'currency', 'Player Secret Mark')
  await open(page, 'settlement', 'Player Read Hold')
  expect(await attach(page, 'Player Secret Mark')).toBe(201)
  const secret = panel(page).getByRole('listitem').filter({ hasText: 'Player Secret Mark' })
  const patched = page.waitForResponse(
    (r) =>
      r.request().method() === 'PATCH' &&
      /\/currency-attachments\//.test(new URL(r.url()).pathname),
  )
  await secret.getByLabel('Player Secret Mark visibility').selectOption('dm_only')
  expect((await patched).status()).toBe(200)

  await logout(page)
  await login(page, 'player1')
  await open(page, 'settlement', 'Player Read Hold')

  await expect(panel(page).getByRole('link', { name: 'Player Visible Mark' })).toBeVisible()
  // Neither hidden row arrives at all — not nameless, not noteless: absent.
  await expect(panel(page).getByRole('link', { name: 'Player Hidden Penny' })).toHaveCount(0)
  await expect(panel(page).getByText('Player Hidden Penny')).toHaveCount(0)
  await expect(panel(page).getByRole('link', { name: 'Player Secret Mark' })).toHaveCount(0)
  await expect(panel(page).getByText('Player Secret Mark')).toHaveCount(0)

  // And no control is offered — the writes behind them are 403 either way.
  await expect(panel(page).getByLabel('Attach a currency')).toHaveCount(0)
  await expect(panel(page).getByRole('button')).toHaveCount(0)
})
