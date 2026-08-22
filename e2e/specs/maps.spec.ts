import { expect, test } from '@playwright/test'
import { login, logout } from '../fixtures'
import { box, clickMapAt, createMapWithImage, expectZoomedIn, openMaps } from '../map-helpers'
import { RESTRICTED_NPC, SEED_NPC } from '../seed-data'

/**
 * Maps end to end: upload, zoom, pin, navigate — and the leak that must not
 * ship.
 *
 * The pin transform has a pure unit suite and the visibility filter has an HTTP
 * suite. What only a real browser proves is that the rendered result agrees with
 * both: that a pin sits over the same point of the IMAGE after a zoom, measured
 * against the real laid-out geometry rather than asserted about the maths.
 */

test('a DM creates a map, uploads an image, and it survives a reload', async ({ page }) => {
  await login(page, 'owner')
  await createMapWithImage(page, 'Saltmarsh')

  const img = page.getByTestId('map-content').locator('img')
  // A broken <img> reports zero natural width, so this fails if the bytes never
  // made the round trip.
  await expect.poll(async () => img.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(1000)

  await page.reload()
  await expect(page.getByTestId('map-content')).toBeVisible()
})

test('a pin holds its position on the image through zoom and back out', async ({ page }) => {
  // The load-bearing claim of the whole feature. Measured against the laid-out
  // geometry, so it fails if the rendering ever stops agreeing with the transform.
  await login(page, 'owner')
  await createMapWithImage(page, 'Anchored')

  await page.getByRole('button', { name: 'Add pin' }).click()
  const content = page.getByTestId('map-content')
  // Off-centre, so zooming about the centre genuinely moves it on screen.
  await clickMapAt(page, 0.3, 0.4)

  await page.getByLabel('Pin an entity').getByRole('button', { name: SEED_NPC.name }).click()
  const marker = content.getByRole('button', { name: SEED_NPC.name })
  await expect(marker).toBeVisible()

  /** Where the pin sits as a fraction of the rendered image. */
  const fraction = async (): Promise<{ x: number; y: number; width: number }> => {
    const c = await box(content)
    const m = await box(marker)
    return {
      x: (m.x + m.width / 2 - c.x) / c.width,
      y: (m.y + m.height / 2 - c.y) / c.height,
      width: c.width,
    }
  }
  const before = await fraction()

  await page.getByRole('button', { name: 'Zoom in' }).click()
  await expectZoomedIn(page, before.width) // the zoom really happened, and has landed
  const zoomed = await fraction()
  expect(Math.abs(zoomed.x - before.x)).toBeLessThan(0.02)
  expect(Math.abs(zoomed.y - before.y)).toBeLessThan(0.02)

  await page.getByRole('button', { name: 'Fit map' }).click()
  const fitted = await fraction()
  expect(Math.abs(fitted.width - before.width)).toBeLessThan(2)
  expect(Math.abs(fitted.x - before.x)).toBeLessThan(0.02)
  expect(Math.abs(fitted.y - before.y)).toBeLessThan(0.02)
})

test('a pin navigates to the entity it marks, and the entity links back', async ({ page }) => {
  await login(page, 'owner')
  await createMapWithImage(page, 'Roundtrip')

  await page.getByRole('button', { name: 'Add pin' }).click()
  const content = page.getByTestId('map-content')
  await clickMapAt(page, 0.5, 0.5)
  await page.getByLabel('Pin an entity').getByRole('button', { name: SEED_NPC.name }).click()

  await page.getByLabel('Pins').getByRole('button', { name: SEED_NPC.name, exact: true }).click()
  // An owner lands on the EDITOR, which has no read-only heading — the name is
  // in the form field, and the URL names the entity the pin marked.
  await expect(page).toHaveURL(/\/npc\/[^/]+$/)
  await expect(page.getByLabel('Name')).toHaveValue(SEED_NPC.name)

  // …and the reverse: the entity page says which maps mark it.
  const pinnedOn = page.getByLabel('Pinned on maps')
  await expect(pinnedOn.getByRole('link', { name: 'Roundtrip' })).toBeVisible()
  await pinnedOn.getByRole('link', { name: 'Roundtrip' }).click()
  await expect(page.getByRole('heading', { name: 'Roundtrip' })).toBeVisible()
})

test('a DM removes a pin and it stays gone', async ({ page }) => {
  await login(page, 'owner')
  await createMapWithImage(page, 'Removable')

  await page.getByRole('button', { name: 'Add pin' }).click()
  await clickMapAt(page, 0.5, 0.5)
  await page.getByLabel('Pin an entity').getByRole('button', { name: SEED_NPC.name }).click()
  await expect(
    page.getByLabel('Pins').getByRole('button', { name: SEED_NPC.name, exact: true }),
  ).toBeVisible()

  await page.getByRole('button', { name: `Remove pin for ${SEED_NPC.name}` }).click()
  await expect(page.getByText('Nothing pinned on this map yet.')).toBeVisible()
  await page.reload()
  await expect(page.getByText('Nothing pinned on this map yet.')).toBeVisible()
})

test('a map is pannable and zoomable from the keyboard alone', async ({ page }) => {
  // A map explorable only by dragging is a map some people cannot explore.
  await login(page, 'owner')
  await createMapWithImage(page, 'Keyboard')

  const content = page.getByTestId('map-content')
  const fitted = await box(content)

  await page.getByTestId('map-frame').focus()
  await page.keyboard.press('+')
  await expect.poll(async () => (await box(content)).width).toBeGreaterThan(fitted.width + 1)

  const zoomedLeft = (await box(content)).x
  await page.keyboard.press('ArrowRight')
  await expect.poll(async () => (await box(content)).x).not.toBe(zoomedLeft)

  await page.keyboard.press('0')
  await expect
    .poll(async () => Math.round((await box(content)).width))
    .toBe(Math.round(fitted.width))
})

test('a player sees the map but is offered nothing that changes it', async ({ page }) => {
  await login(page, 'owner')
  await createMapWithImage(page, 'Shared')

  await logout(page)
  await login(page, 'player1')
  await openMaps(page)
  await page.getByRole('link', { name: 'Shared' }).click()

  await expect(page.getByTestId('map-content')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Add pin' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Delete map' })).toHaveCount(0)
  await expect(page.getByLabel(/map image/)).toHaveCount(0)
})

test('a pin naming an entity the player cannot see is not on their map at all', async ({
  page,
}) => {
  // The acceptance criterion the task calls the one that matters most. The map
  // is public; the pin's target is not; the pin's LABEL would say the secret out
  // loud even if the name were filtered.
  await login(page, 'owner')
  await createMapWithImage(page, 'Leaky')

  await page.getByRole('button', { name: 'Add pin' }).click()
  await clickMapAt(page, 0.7, 0.7)
  await page.getByLabel('Pin an entity').getByRole('button', { name: RESTRICTED_NPC.name }).click()
  await expect(
    page.getByLabel('Pins').getByRole('button', { name: RESTRICTED_NPC.name, exact: true }),
  ).toBeVisible()

  // player2 holds no grant for the restricted NPC.
  await logout(page)
  await login(page, 'player2')
  await openMaps(page)
  await page.getByRole('link', { name: 'Leaky' }).click()
  await expect(page.getByTestId('map-content')).toBeVisible()

  await expect(page.getByText('Nothing pinned on this map yet.')).toBeVisible()
  // Not merely hidden from the list: the name is nowhere in the delivered page.
  expect(await page.content()).not.toContain(RESTRICTED_NPC.name)

  // player1 IS granted, so the same map shows them the pin.
  await logout(page)
  await login(page, 'player1')
  await openMaps(page)
  await page.getByRole('link', { name: 'Leaky' }).click()
  await expect(
    page.getByLabel('Pins').getByRole('button', { name: RESTRICTED_NPC.name, exact: true }),
  ).toBeVisible()
})

/**
 * Sharing a map with SOME players — the granularity maps did not have until
 * migration 0016 gave them their own grant ACL.
 *
 * The fixture is chosen so the two grants pull in opposite directions: the map
 * is shared with player2, who is the player WITHOUT a grant on the restricted
 * NPC. So player2 can open the map and still cannot see the pin on it. If a map
 * grant implied pin visibility, that pin would appear — which is the whole
 * thing this asserts does not happen.
 */
test('a DM shares one map with one player, and the pin filter still holds', async ({ page }) => {
  // Stamped for the same reason the passages spec stamps its reveals: a retry
  // re-runs against the database the failed attempt already wrote to, so a
  // fixed name would leave two identically-named map links to disambiguate.
  const mapName = `The Splinter Route ${Date.now()}`

  await login(page, 'owner')
  await createMapWithImage(page, mapName)

  // Two pins: one anyone may see, one only a player granted the restricted NPC may.
  await page.getByRole('button', { name: 'Add pin' }).click()
  await clickMapAt(page, 0.3, 0.3)
  await page.getByLabel('Pin an entity').getByRole('button', { name: SEED_NPC.name }).click()

  await page.getByRole('button', { name: 'Add pin' }).click()
  await clickMapAt(page, 0.6, 0.6)
  await page.getByLabel('Pin an entity').getByRole('button', { name: RESTRICTED_NPC.name }).click()

  // Share the MAP with player2 — who holds NO grant on the restricted NPC.
  await page.getByLabel('Visibility').selectOption({ label: 'Only the players you choose' })
  await page.getByRole('button', { name: 'Grant e2e-player2' }).click()
  await expect(page.getByRole('button', { name: 'Revoke e2e-player2' })).toBeVisible()
  const mapUrl = new URL(page.url()).pathname
  await logout(page)

  // — player1 was NOT granted the map, so it is not theirs to open —
  await login(page, 'player1')
  await openMaps(page)
  await expect(page.getByRole('link', { name: mapName })).toHaveCount(0)
  await logout(page)

  // — player2 opens the map, and sees only the pin they are entitled to —
  await login(page, 'player2')
  await openMaps(page)
  await expect(page.getByRole('link', { name: mapName })).toBeVisible()
  await page.goto(mapUrl)
  await expect(page.getByTestId('map-content')).toBeVisible()
  const pins = page.getByLabel('Pins')
  await expect(pins.getByRole('button', { name: SEED_NPC.name, exact: true })).toBeVisible()
  await expect(pins.getByRole('button', { name: RESTRICTED_NPC.name, exact: true })).toHaveCount(0)
})
