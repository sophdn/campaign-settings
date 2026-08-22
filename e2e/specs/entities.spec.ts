import { expect, test } from '@playwright/test'
import { login } from '../fixtures'
import { SEED_NPC, WORLD } from '../seed-data'

test('the seeded npc renders on the entity list', async ({ page }) => {
  await login(page, 'owner')
  await page.getByRole('link', { name: WORLD.name }).click()
  await expect(page).toHaveURL(/\/worlds\/[^/]+$/)

  // Visit the NPC list for the world we just opened (slug taken from the URL).
  const worldPath = new URL(page.url()).pathname
  await page.goto(`${worldPath}/npc`)
  await expect(page.getByRole('link', { name: SEED_NPC.name })).toBeVisible()
})
