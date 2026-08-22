import { type Locator, type Page, expect } from '@playwright/test'
import { makePng } from '../packages/server/src/testing/images'
import { clickNavLink } from './fixtures'
import { WORLD } from './seed-data'

/**
 * Shared map-page drivers. Extracted rather than duplicated because the
 * narrow-viewport checks live in their own spec file: Playwright refuses
 * `test.use({ ...devices[…] })` inside a describe group, since a device profile
 * names a browser type and that forces a new worker.
 */

/** Open the seeded world's map index. */
export async function openMaps(page: Page): Promise<void> {
  await page.getByRole('link', { name: WORLD.name }).click()
  await expect(page).toHaveURL(/\/worlds\/[^/]+$/)
  // Through the nav wherever it is: on a phone the rail is a drawer, and the
  // narrow-viewport specs run this same helper.
  await clickNavLink(page, 'Maps')
  await expect(page.getByRole('heading', { name: 'Maps' })).toBeVisible()
}

/** Create a map, upload a 1000×500 image to it, and land on its page. */
export async function createMapWithImage(page: Page, name: string): Promise<void> {
  await openMaps(page)
  await page.getByLabel('Name').fill(name)
  await page.getByRole('button', { name: 'Add' }).click()
  await page.getByRole('link', { name }).click()
  await expect(page.getByRole('heading', { name })).toBeVisible()

  await page.getByLabel('Upload a map image').setInputFiles({
    name: `${name}.png`,
    mimeType: 'image/png',
    buffer: makePng(1000, 500),
  })
  await expect(page.getByTestId('map-content')).toBeVisible()
}

/** A locator's laid-out box, or a failure that says which element had none. */
export async function box(
  locator: Locator,
): Promise<{ x: number; y: number; width: number; height: number }> {
  const rect = await locator.boundingBox()
  if (rect === null) throw new Error('element has no bounding box')
  return rect
}

/**
 * Click a point on the map image, given as a fraction of the IMAGE.
 *
 * Playwright's `position` is relative to the element being clicked, while
 * `boundingBox()` reports page coordinates — mixing the two lands the click
 * somewhere else entirely, which on this page means the file input below the
 * frame swallows it.
 */
export async function clickMapAt(page: Page, fx: number, fy: number): Promise<void> {
  const frame = page.getByTestId('map-frame')
  const f = await box(frame)
  const c = await box(page.getByTestId('map-content'))
  await frame.click({
    position: { x: c.x - f.x + c.width * fx, y: c.y - f.y + c.height * fy },
  })
}

/**
 * Wait for a zoom to actually land before measuring anything else.
 *
 * The click returns as soon as it dispatches; React's state update and the
 * re-layout happen after, so a plain read can catch the pre-zoom geometry.
 */
export async function expectZoomedIn(page: Page, wasWidth: number): Promise<void> {
  await expect
    .poll(async () => (await box(page.getByTestId('map-content'))).width)
    .toBeGreaterThan(wasWidth + 1)
}
