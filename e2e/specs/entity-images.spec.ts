import { expect, test } from '@playwright/test'
import { makeNotAnImage, makePng } from '../../packages/server/src/testing/images'
import { login, logout } from '../fixtures'
import { RESTRICTED_NPC, SEED_NPC, WORLD } from '../seed-data'

/**
 * Uploading an image to an entity, end to end in a real browser.
 *
 * The unit and HTTP suites cover the byte handling and every refusal. What only
 * a real browser can prove is the part that depends on one: the canvas actually
 * produces a thumbnail from a picked file, the gallery renders the bytes that
 * came back, and a player's session is served none of it.
 */

/** Open the seeded world and return its URL path. */
async function openWorld(page: import('@playwright/test').Page): Promise<string> {
  await page.getByRole('link', { name: WORLD.name }).click()
  await expect(page).toHaveURL(/\/worlds\/[^/]+$/)
  return new URL(page.url()).pathname
}

async function openNpc(page: import('@playwright/test').Page, name: string): Promise<void> {
  const worldPath = await openWorld(page)
  await page.goto(`${worldPath}/npc`)
  await page.getByRole('link', { name }).click()
  await expect(page.getByRole('heading', { name: 'Images' })).toBeVisible()
}

test('a DM uploads an image and it appears in the gallery without a reload', async ({ page }) => {
  await login(page, 'owner')
  await openNpc(page, SEED_NPC.name)

  const panel = page.getByLabel('Images')
  await expect(panel.getByText('No images yet.')).toBeVisible()

  // 900×600 is comfortably over the 512 px thumbnail box, so the browser has a
  // real downscale to do rather than declining.
  await page.getByLabel('Add an image').setInputFiles({
    name: 'saltmarsh.png',
    mimeType: 'image/png',
    buffer: makePng(900, 600),
  })

  await expect(panel.getByText('Added saltmarsh.png')).toBeVisible()
  const img = panel.getByAltText('View saltmarsh.png full size')
  await expect(img).toBeVisible()

  // The image is really painted — a broken <img> reports zero natural width, so
  // this fails if the bytes never made the round trip.
  await expect
    .poll(async () => img.evaluate((el: HTMLImageElement) => el.naturalWidth))
    .toBeGreaterThan(0)

  // …and what the gallery pulled is the THUMBNAIL, not the 900px source.
  await expect(img).toHaveAttribute('src', /variant=thumbnail/)
  await expect
    .poll(async () => img.evaluate((el: HTMLImageElement) => el.naturalWidth))
    .toBeLessThan(900)
})

test('the upload survives a page reload, because it is stored and not merely rendered', async ({
  page,
}) => {
  await login(page, 'owner')
  await openNpc(page, SEED_NPC.name)
  await page.getByLabel('Add an image').setInputFiles({
    name: 'persisted.png',
    mimeType: 'image/png',
    buffer: makePng(700, 500),
  })
  await expect(page.getByAltText('View persisted.png full size')).toBeVisible()

  await page.reload()
  await expect(page.getByAltText('View persisted.png full size')).toBeVisible()
})

test('a file that is not an image is refused with a message the DM can act on', async ({
  page,
}) => {
  await login(page, 'owner')
  await openNpc(page, SEED_NPC.name)

  // A PDF wearing a .png name and an image content type. Every signal the
  // uploader controls says "png"; the bytes do not.
  await page.getByLabel('Add an image').setInputFiles({
    name: 'trojan.png',
    mimeType: 'image/png',
    buffer: makeNotAnImage(),
  })

  await expect(page.getByText(/not a JPEG, PNG, or WebP image/)).toBeVisible()
  await expect(page.getByAltText('View trojan.png full size')).toHaveCount(0)
})

test('a DM removes an image and it is gone after a reload', async ({ page }) => {
  await login(page, 'owner')
  await openNpc(page, SEED_NPC.name)
  await page.getByLabel('Add an image').setInputFiles({
    name: 'doomed.png',
    mimeType: 'image/png',
    buffer: makePng(600, 600),
  })
  await expect(page.getByAltText('View doomed.png full size')).toBeVisible()

  await page.getByRole('button', { name: 'Remove doomed.png' }).click()
  await expect(page.getByAltText('View doomed.png full size')).toHaveCount(0)

  await page.reload()
  await expect(page.getByAltText('View doomed.png full size')).toHaveCount(0)
})

test('a player is offered no upload control and cannot remove anything', async ({ page }) => {
  await login(page, 'owner')
  await openNpc(page, SEED_NPC.name)
  await page.getByLabel('Add an image').setInputFiles({
    name: 'shared.png',
    mimeType: 'image/png',
    buffer: makePng(600, 400),
  })
  await expect(page.getByAltText('View shared.png full size')).toBeVisible()

  await logout(page)
  await login(page, 'player1')
  await openNpc(page, SEED_NPC.name)

  // A player sees the image on a public entity — the panel is not owner-only.
  await expect(page.getByAltText('View shared.png full size')).toBeVisible()
  // …but is offered nothing that writes.
  await expect(page.getByLabel('Add an image')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Remove shared.png' })).toHaveCount(0)
})

test('an image on a restricted entity is unreachable for an ungranted player', async ({ page }) => {
  // The load-bearing one: media visibility IS its owner entity's, so a hidden
  // NPC's portrait must not be fetchable even with its direct URL.
  await login(page, 'owner')
  await openNpc(page, RESTRICTED_NPC.name)
  await page.getByLabel('Add an image').setInputFiles({
    name: 'secret.png',
    mimeType: 'image/png',
    buffer: makePng(600, 400),
  })
  await expect(page.getByAltText('View secret.png full size')).toBeVisible()
  // Read the source URL out of the UI rather than composing it, so the spec
  // asks for the same address a reader would reach. It lives in the lightbox
  // now: the thumbnail opens a dialog rather than linking anywhere.
  await page.getByRole('button', { name: 'View secret.png full size' }).click()
  const rawUrl = await page
    .getByRole('dialog', { name: 'secret.png' })
    .getByRole('link', { name: 'Open secret.png in a new tab' })
    .getAttribute('href')
  expect(rawUrl).toBeTruthy()
  // The dialog is modal — its scrim swallows every click, including the one
  // that signs out below.
  await page.keyboard.press('Escape')

  // player2 holds no grant for the restricted NPC.
  await logout(page)
  await login(page, 'player2')
  const direct = await page.request.get(rawUrl as string)
  expect(direct.status()).toBe(404)
})

test('clicking a thumbnail opens the full-size image, and Escape closes it', async ({ page }) => {
  await login(page, 'owner')
  await openNpc(page, SEED_NPC.name)
  await page.getByLabel('Add an image').setInputFiles({
    name: 'closeup.png',
    mimeType: 'image/png',
    buffer: makePng(900, 600),
  })
  await expect(page.getByAltText('View closeup.png full size')).toBeVisible()

  await page.getByRole('button', { name: 'View closeup.png full size' }).click()

  const dialog = page.getByRole('dialog', { name: 'closeup.png' })
  await expect(dialog).toBeVisible()
  const full = dialog.getByAltText('closeup.png')
  // The SOURCE, not the thumbnail scaled up — looking closely is the point, and
  // only a real browser can say which bytes actually got painted.
  await expect(full).not.toHaveAttribute('src', /variant=thumbnail/)
  await expect.poll(async () => full.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(900)

  // The shared modal's mechanics come along with it rather than being
  // reimplemented per feature.
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(page.getByAltText('View closeup.png full size')).toBeVisible()
})

test('the plus at the top sets THE image, and it survives a reload', async ({ page }) => {
  await login(page, 'owner')
  await openNpc(page, SEED_NPC.name)

  // No image yet: a neutral disc, not a broken frame and not an empty gap.
  const avatar = page.locator('.entity-avatar')
  await expect(avatar.locator('.entity-avatar-empty')).toBeVisible()

  await page.getByLabel('Add a main image').setInputFiles({
    name: 'portrait.png',
    mimeType: 'image/png',
    buffer: makePng(800, 800),
  })

  // One gesture uploaded it AND nominated it — the avatar now shows it, and the
  // gallery below marks the same row.
  const img = avatar.getByAltText('portrait.png')
  await expect(img).toBeVisible()
  await expect(img).toHaveAttribute('src', /variant=thumbnail/)
  await expect
    .poll(async () => img.evaluate((el: HTMLImageElement) => el.naturalWidth))
    .toBeGreaterThan(0)
  await expect(page.getByLabel('Images').getByText('Main image')).toBeVisible()

  // Stored, not merely rendered.
  await page.reload()
  await expect(page.locator('.entity-avatar').getByAltText('portrait.png')).toBeVisible()
})

test('the gallery promotes an image the avatar’s plus did not upload', async ({ page }) => {
  await login(page, 'owner')
  await openNpc(page, SEED_NPC.name)

  await page.getByLabel('Add an image').setInputFiles({
    name: 'promoted.png',
    mimeType: 'image/png',
    buffer: makePng(700, 700),
  })
  await expect(page.getByAltText('View promoted.png full size')).toBeVisible()

  // The plus uploads a NEW file; this is how an owner promotes one already
  // attached, which is the whole reason the flag lives per-attachment.
  await page.getByRole('button', { name: 'Use promoted.png as the main image' }).click()

  // The avatar re-reads rather than staying on whatever it showed before.
  await expect(page.locator('.entity-avatar').getByAltText('promoted.png')).toBeVisible()

  // Standing it down clears the avatar and keeps the file in the gallery.
  await page.getByRole('button', { name: 'Stop using promoted.png as the main image' }).click()
  await expect(page.locator('.entity-avatar').locator('.entity-avatar-empty')).toBeVisible()
  await expect(page.getByAltText('View promoted.png full size')).toBeVisible()
})

test('a player sees the main image and is offered no plus', async ({ page }) => {
  await login(page, 'owner')
  await openNpc(page, SEED_NPC.name)
  await page.getByLabel('Add a main image').setInputFiles({
    name: 'seen.png',
    mimeType: 'image/png',
    buffer: makePng(600, 600),
  })
  await expect(page.locator('.entity-avatar').getByAltText('seen.png')).toBeVisible()

  await logout(page)
  await login(page, 'player1')
  await openNpc(page, SEED_NPC.name)

  await expect(page.locator('.entity-avatar').getByAltText('seen.png')).toBeVisible()
  await expect(page.getByLabel(/main image/)).toHaveCount(0)
  await expect(page.getByRole('button', { name: /as the main image$/ })).toHaveCount(0)
})
