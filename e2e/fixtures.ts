import { type Page, expect } from '@playwright/test'
import { ACCOUNTS, type AccountKey } from './seed-data'

/**
 * Log in through the real UI and assert we land on the world picker. Specs use
 * this instead of injecting a session cookie so the auth flow itself is covered.
 */
export async function login(page: Page, key: AccountKey = 'owner'): Promise<void> {
  const acct = ACCOUNTS[key]
  await page.goto('/login')
  await page.getByLabel('Username').fill(acct.username)
  await page.getByLabel('Password').fill(acct.password)
  await page.getByRole('button', { name: 'Log in' }).click()
  await expect(page.getByRole('heading', { name: 'Your worlds' })).toBeVisible()
}

/** Sign out through the header control, for specs that switch identities mid-test. */
export async function logout(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Log out' }).click()
  await expect(page).toHaveURL(/\/login$/)
}

/**
 * Open an entity page's editor.
 *
 * The editor starts COLLAPSED behind a pencil, so an entity page opens as
 * readable prose. Every spec that edits an entity presses that pencil first
 * rather than reaching past it — weakening a locator to find the hidden form
 * would quietly delete the assertion the page was changed to make.
 *
 * Idempotent: calling it on an already-open editor leaves it open.
 */
export async function openEntityEditor(
  page: Page,
  label: 'entity' | 'session' = 'entity',
): Promise<void> {
  const form = page.getByRole('form', { name: `Edit ${label}` })
  if (!(await form.isVisible())) {
    await page.getByRole('button', { name: `Edit ${label}` }).click()
  }
  await expect(form).toBeVisible()
}

/**
 * Unfold a secondary panel that renders as a closed accordion.
 *
 * Type, Relationships and Mentioned-in-this-entry open closed: they are
 * secondary, and a page you came to read should not open as a stack of every
 * answer at once. A closed `<details>` takes its contents off the accessibility
 * tree, so a spec that needs a control inside one presses the fold first.
 *
 * Idempotent: an already-open panel is left open.
 */
export async function openPanel(page: Page, name: string): Promise<void> {
  const region = page.getByRole('region', { name })
  const details = region.locator('details').first()
  await expect(details).toBeAttached()
  // Polled rather than clicked once. Following a link inside a panel navigates
  // the SPA, and for a moment the old page's open panel is still what a locator
  // resolves to — a single "is it open? no, click" would then read the old
  // answer and leave the new page folded. Retrying until it is actually open
  // settles that without a sleep.
  await expect
    .poll(async () => {
      if (await details.evaluate((el) => (el as HTMLDetailsElement).open)) return true
      await region.locator('summary').first().click()
      return details.evaluate((el) => (el as HTMLDetailsElement).open)
    })
    .toBe(true)
}

/**
 * Follow a link in the world nav, wherever the nav currently is.
 *
 * Below the breakpoint the rail is not rendered at all — it is a drawer — so a
 * spec running at a phone width cannot reach a rail link directly. This opens
 * the drawer first when it has to, which keeps the phone specs driving the same
 * navigation a person would rather than reaching around the layout.
 */
export async function clickNavLink(page: Page, name: string): Promise<void> {
  // Wait for the world chrome FIRST. `isVisible()` does not retry, and the
  // layout renders a loading line before the nav exists — so checking too early
  // reports "no rail" on a desktop and sends this down the drawer path, where
  // it waits thirty seconds for a hamburger that is correctly hidden.
  await expect(page.locator('.world')).toBeVisible()
  const rail = page.locator('.world-nav').first()
  if (await rail.isVisible()) {
    await rail.getByRole('link', { name, exact: true }).click()
    return
  }
  await page.getByRole('button', { name: 'World sections' }).click()
  await page
    .getByRole('dialog', { name: 'World sections' })
    .getByRole('link', { name, exact: true })
    .click()
}
