import { expect, test } from '@playwright/test'
import { login } from '../fixtures'
import { WORLD } from '../seed-data'

test('the seeded world is listed and opens', async ({ page }) => {
  await login(page, 'owner')
  const worldLink = page.getByRole('link', { name: WORLD.name })
  await expect(worldLink).toBeVisible()
  await worldLink.click()
  await expect(page).toHaveURL(/\/worlds\/[^/]+$/)
})
