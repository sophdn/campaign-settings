import { expect, test } from '@playwright/test'
import { login } from '../fixtures'
import { SEED_NPC, WORLD } from '../seed-data'

/**
 * Taking the whole world away as a file.
 *
 * The route and the SDK method both existed for a long time with no call site,
 * so what needs proving is not the export itself — the HTTP suite covers the
 * payload and the owner gate — but that a person can actually get the file. A
 * download is the one thing no unit test can assert: it needs a real browser to
 * accept a blob URL, honour the `download` attribute, and hand over bytes.
 */

test('the owner exports the world and a real file arrives', async ({ page }) => {
  await login(page, 'owner')
  await page.getByRole('link', { name: WORLD.name }).click()
  await expect(page).toHaveURL(/\/worlds\/[^/]+$/)
  const worldPath = new URL(page.url()).pathname

  await page.getByRole('link', { name: 'Settings' }).click()
  const panel = page.getByLabel('Export this world')
  await expect(panel).toBeVisible()

  await panel.getByRole('button', { name: 'Prepare an export' }).click()
  const link = panel.getByRole('link', { name: /^Download / })
  await expect(link).toBeVisible()

  const [download] = await Promise.all([page.waitForEvent('download'), link.click()])

  // Named for the world and the day, so a folder of these is legible a year on.
  const slug = worldPath.replace('/worlds/', '')
  expect(download.suggestedFilename()).toMatch(new RegExp(`^${slug}-\\d{4}-\\d{2}-\\d{2}\\.json$`))

  // A real copy of the world, not an empty envelope: the seeded NPC is in it.
  const path = await download.path()
  const body = JSON.parse(await (await import('node:fs/promises')).readFile(path, 'utf8')) as {
    version: number
    tables: Record<string, Array<Record<string, unknown>>>
  }
  expect(body.version).toBe(1)
  expect(body.tables.entities?.some((e) => e.name === SEED_NPC.name)).toBe(true)
})

test('a player is offered no export', async ({ page }) => {
  await login(page, 'player1')
  await page.getByRole('link', { name: WORLD.name }).click()
  await expect(page).toHaveURL(/\/worlds\/[^/]+$/)

  // Not in the nav, and not on the page for someone who types the address —
  // the server refuses their export either way, which `http.test.ts` pins.
  await expect(page.getByRole('link', { name: 'Settings' })).toHaveCount(0)
  await page.goto(`${new URL(page.url()).pathname}/settings`)
  await expect(page.getByLabel('Export this world')).toHaveCount(0)
  await expect(page.getByText(/Only the GM can change/i)).toBeVisible()
})
