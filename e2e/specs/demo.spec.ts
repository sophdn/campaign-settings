import { expect, test } from '@playwright/test'
import { WORLD } from '../seed-data'

/**
 * The portfolio's front door, end to end: no credentials entered, straight into
 * the app, and every write refused with the contact modal in its place.
 */
test('the demo link signs a visitor in and lands them in the app', async ({ page }) => {
  await page.goto('/demo')

  await expect(page.getByRole('heading', { name: 'Your worlds' })).toBeVisible()
  await expect(page.getByRole('link', { name: WORLD.name })).toBeVisible()
})

test('a demo visitor can read a world but is offered the contact modal instead of writing', async ({
  page,
}) => {
  await page.goto('/demo')
  // The sign-in happens on arrival, with nothing to click. Wait for it to land
  // before asking for anything behind it, so a failure here reads as "the demo
  // never got in" rather than "a world link was missing".
  await expect(page.getByRole('heading', { name: 'Your worlds' })).toBeVisible()
  await page.getByRole('link', { name: WORLD.name }).click()
  await expect(page).toHaveURL(/\/worlds\/[^/]+$/)
  const worldPath = new URL(page.url()).pathname

  // reading works
  await page.goto(`${worldPath}/npc`)
  await expect(page.getByRole('link', { name: 'Test NPC' })).toBeVisible()

  // the member list is readable too
  await page.getByRole('link', { name: 'Members' }).click()
  await expect(page.getByRole('heading', { name: 'Members' })).toBeVisible()

  // but leaving the world — a mutation — is refused, and the contact modal
  // carries the explanation rather than a raw error
  await page.getByRole('button', { name: 'Leave this world' }).click()
  await page.getByRole('button', { name: 'Yes, leave and delete my data' }).click()
  await expect(page.getByRole('alert')).toBeVisible()
  // still a member: the refusal was real, not cosmetic
  await expect(page).toHaveURL(new RegExp(`${worldPath}/members$`))
})
