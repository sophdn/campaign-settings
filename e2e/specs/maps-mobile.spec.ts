import { devices, expect, test } from '@playwright/test'
import { login } from '../fixtures'
import { box, clickMapAt, createMapWithImage, expectZoomedIn } from '../map-helpers'

/**
 * The map viewer on a narrow viewport.
 *
 * An emulated phone rather than a resized desktop window: what differs is the
 * device pixel ratio and touch input, and both change what the frame measures
 * and how a gesture arrives. This lives in its own file because a device profile
 * names a browser type, which Playwright will not accept inside a describe.
 */
test.use({ ...devices['Pixel 5'] })

test('the map fits its frame, does not widen the page, and keeps its controls reachable', async ({
  page,
}) => {
  await login(page, 'owner')
  await createMapWithImage(page, 'Pocket')

  const frame = await box(page.getByTestId('map-frame'))
  const content = await box(page.getByTestId('map-content'))

  // The map's own containment. That the PAGE does not scroll sideways is the
  // shell's invariant and is asserted for every surface in responsive.spec.ts;
  // what matters here is that the frame fits the column it was given.
  const viewportWidth = page.viewportSize()?.width ?? 0
  expect(frame.width).toBeLessThanOrEqual(viewportWidth)

  // The image is contained by its frame rather than overflowing it.
  expect(content.width).toBeLessThanOrEqual(frame.width + 1)
  expect(content.height).toBeLessThanOrEqual(frame.height + 1)

  for (const name of ['Zoom in', 'Zoom out', 'Fit map']) {
    await expect(page.getByRole('button', { name })).toBeVisible()
  }
  await page.getByRole('button', { name: 'Zoom in' }).click()
  await expectZoomedIn(page, content.width)
})

test('a pin still holds its image position after a zoom on a phone-sized frame', async ({
  page,
}) => {
  // Same invariant as the desktop spec, re-measured against a frame whose
  // fitted size is entirely different — the transform is viewport-relative, so
  // a bug that only shows at one aspect ratio would pass the other test.
  await login(page, 'owner')
  await createMapWithImage(page, 'PocketPin')

  await page.getByRole('button', { name: 'Add pin' }).click()
  const content = page.getByTestId('map-content')
  await clickMapAt(page, 0.3, 0.4)
  await page.getByLabel('Pin an entity').getByRole('button', { name: 'Test NPC' }).click()

  const marker = content.getByRole('button', { name: 'Test NPC' })
  await expect(marker).toBeVisible()
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
  await expectZoomedIn(page, before.width)
  const zoomed = await fraction()
  expect(Math.abs(zoomed.x - before.x)).toBeLessThan(0.03)
  expect(Math.abs(zoomed.y - before.y)).toBeLessThan(0.03)
})
