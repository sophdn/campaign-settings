import { type Page, expect, test } from '@playwright/test'
import { login, logout } from '../fixtures'
import { ACCOUNTS, WORLD } from '../seed-data'

/** Open the seeded world's members page; returns the world root path. */
async function openMembers(page: Page): Promise<string> {
  await page.getByRole('link', { name: WORLD.name }).click()
  await expect(page).toHaveURL(/\/worlds\/[^/]+$/)
  const worldPath = new URL(page.url()).pathname
  await page.getByRole('link', { name: 'Members' }).click()
  await expect(page.getByRole('heading', { name: 'Members' })).toBeVisible()
  return worldPath
}

/**
 * The member list panel specifically. Names appear in BOTH the member list and
 * the invitation list, so an unscoped locator is ambiguous once someone has been
 * invited — and "is a member" is what these assertions are actually about.
 */
const memberList = (page: Page) => page.getByLabel('Members', { exact: true })

test('the owner invites a stranger, they join, and the owner removes them again', async ({
  page,
}) => {
  const stranger = ACCOUNTS.stranger.username

  // ── invite ──
  await login(page, 'owner')
  await openMembers(page)
  await expect(memberList(page).getByText(stranger)).toHaveCount(0)

  await page.getByLabel('Username (leave blank for an open link)').fill(stranger)
  await page.getByRole('button', { name: 'Create invitation' }).click()

  // The raw token is shown exactly once, here, and nowhere afterwards.
  const link = page.locator('code')
  await expect(link).toBeVisible()
  const inviteUrl = (await link.textContent()) ?? ''
  expect(inviteUrl).toMatch(/\/invite\/.+/)

  // and it is listed as pending
  await expect(
    page.getByRole('button', { name: `Revoke invitation for ${stranger}` }),
  ).toBeVisible()

  // ── the invitee accepts ──
  await logout(page)
  await login(page, 'stranger')
  await page.goto(new URL(inviteUrl).pathname)
  await page.getByRole('button', { name: `Join ${WORLD.name}` }).click()
  await expect(page).toHaveURL(/\/worlds\/[^/]+$/)

  // ── the member appears ──
  await logout(page)
  await login(page, 'owner')
  await openMembers(page)
  await expect(memberList(page).getByText(stranger, { exact: true })).toBeVisible()
  // the invitation has moved on from pending, so it is no longer revocable
  await expect(page.getByRole('button', { name: `Revoke invitation for ${stranger}` })).toHaveCount(
    0,
  )

  // ── and can be removed ──
  await page.getByRole('button', { name: `Remove ${stranger}` }).click()
  await expect(memberList(page).getByText(stranger, { exact: true })).toHaveCount(0)
})

test('a player sees the member list but is offered no way to change it', async ({ page }) => {
  await login(page, 'player1')
  await openMembers(page)

  // the list itself is readable
  await expect(memberList(page).getByText(ACCOUNTS.owner.username, { exact: true })).toBeVisible()

  // but nothing that mutates it is on offer
  await expect(page.getByLabel('Username (leave blank for an open link)')).toHaveCount(0)
  await expect(page.getByRole('button', { name: /^Remove / })).toHaveCount(0)
  await expect(page.getByRole('button', { name: /^Revoke invitation/ })).toHaveCount(0)
})
