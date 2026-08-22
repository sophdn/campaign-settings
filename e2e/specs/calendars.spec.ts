import { expect, type Locator, type Page, test } from '@playwright/test'
import { login, logout, openEntityEditor } from '../fixtures'
import { WORLD } from '../seed-data'

/**
 * Calendars, end to end.
 *
 * The claims a browser is needed for, and none of them are covered below the API:
 * a structured config survives a real jsonb round trip and comes back as FIELDS
 * rather than as JSON; `formatDate` renders the same way on the settings page and
 * on a session's date field, because both read one function from `shared`; the
 * active calendar actually changes what a session's date control IS; and a player
 * can read the world's calendar while being offered nothing to change.
 *
 * Calendars are world config, so they live on the settings page next to the rename
 * form rather than on an entity page. Each test makes its own calendar with a
 * unique name: the e2e database is seeded once and the specs share it.
 */

const panel = (page: Page): Locator => page.getByRole('region', { name: 'Calendars' })

/** The settings page of the seeded world, from wherever the test currently is. */
async function openSettings(page: Page): Promise<void> {
  await page.goto('/')
  await page.getByRole('link', { name: WORLD.name }).click()
  await expect(page).toHaveURL(/\/worlds\/[^/]+$/)
  await page.goto(`${new URL(page.url()).pathname}/settings`)
  await expect(panel(page)).toBeVisible()
}

/** One calendar's row, scoped so a badge cannot match the add-form's options. */
const row = (page: Page, name: string): Locator =>
  panel(page).getByRole('listitem').filter({ hasText: name })

async function addCalendar(page: Page, name: string, kind: 'Custom' | 'Gregorian'): Promise<void> {
  await panel(page).getByLabel('New calendar').fill(name)
  await panel(page).getByLabel('Calendar kind').selectOption({ label: kind })
  await panel(page).getByRole('button', { name: 'Add calendar' }).click()
  await expect(row(page, name)).toBeVisible()
}

test('a GM writes a custom calendar as structure and it survives a reload', async ({ page }) => {
  await login(page, 'owner')
  await openSettings(page)
  await addCalendar(page, 'Harvest Reckoning', 'Custom')

  await row(page, 'Harvest Reckoning')
    .getByRole('button', { name: 'Edit Harvest Reckoning' })
    .click()
  const form = panel(page).getByLabel('Configure Harvest Reckoning')

  // Months are FIELDS, not JSON. This is the acceptance criterion, asserted as the
  // absence of a textarea as much as the presence of the inputs.
  await expect(form.locator('textarea')).toHaveCount(0)
  await form.getByRole('button', { name: 'Add month' }).click()
  await form.getByLabel('Month 1 name').fill('Seedfall')
  await form.getByLabel('Month 1 length').fill('28')
  await form.getByRole('button', { name: 'Add month' }).click()
  await form.getByLabel('Month 2 name').fill('Highsun')
  await form.getByLabel('Month 2 length').fill('31')
  await form.getByLabel('Weekdays').fill('Restday, Toilday')
  await form.getByLabel('Eras').fill('HR')
  await form.getByLabel('Leap years').fill('none worth counting')

  // The preview renders the UNSAVED draft through `formatDate`.
  await expect(form.getByText('Seedfall 15, 2026 HR')).toBeVisible()
  await form.getByRole('button', { name: 'Save calendar' }).click()

  // A full reload, so what comes back is out of the jsonb column.
  await page.reload()
  const saved = row(page, 'Harvest Reckoning')
  // Scoped to the month LIST: "Seedfall" also appears in the formatted sample.
  // By list ITEM: the name and its length share one <li>, so no element's text is
  // exactly "Seedfall".
  const monthList = saved.getByRole('list')
  await expect(monthList.getByRole('listitem').filter({ hasText: 'Seedfall' })).toBeVisible()
  await expect(monthList.getByRole('listitem').filter({ hasText: '28 days' })).toBeVisible()
  await expect(monthList.getByRole('listitem').filter({ hasText: 'Highsun' })).toBeVisible()
  await expect(saved.getByText('Weekdays: Restday, Toilday')).toBeVisible()
  await expect(saved.getByText('Eras: HR')).toBeVisible()
  await expect(saved.getByText('Leap years: none worth counting')).toBeVisible()
  await expect(saved.getByText('Seedfall 15, 2026 HR')).toBeVisible()
})

test('exactly one calendar is active, and activating one clears the other', async ({ page }) => {
  await login(page, 'owner')
  await openSettings(page)
  await addCalendar(page, 'Active Alpha', 'Gregorian')
  await addCalendar(page, 'Active Beta', 'Gregorian')

  // Created inactive: activating is its own act, because it changes how every
  // existing session date reads.
  await expect(panel(page).getByText('Active', { exact: true })).toHaveCount(0)

  await row(page, 'Active Alpha').getByRole('button', { name: 'Make Active Alpha active' }).click()
  await expect(row(page, 'Active Alpha').getByText('Active', { exact: true })).toBeVisible()

  await row(page, 'Active Beta').getByRole('button', { name: 'Make Active Beta active' }).click()
  await expect(row(page, 'Active Beta').getByText('Active', { exact: true })).toBeVisible()
  // The invariant, across the whole panel rather than one row.
  await expect(panel(page).getByText('Active', { exact: true })).toHaveCount(1)

  // …and it holds after a reload, so it is the stored flag and not local state.
  await page.reload()
  await expect(panel(page).getByText('Active', { exact: true })).toHaveCount(1)
  await expect(row(page, 'Active Beta').getByText('Active', { exact: true })).toBeVisible()
})

/**
 * The session side. `played_at` is free text until the world has an active
 * calendar, which is the fallback the task asked to keep — so this drives the
 * whole arc: free text, then a custom picker, then free text again once the
 * calendar is gone.
 */
test('the active calendar drives a session’s date control, and its absence restores free text', async ({
  page,
}) => {
  await login(page, 'owner')

  // A session in a world with no active calendar keeps the plain field.
  await page.goto('/')
  await page.getByRole('link', { name: WORLD.name }).click()
  const worldPath = new URL(page.url()).pathname
  await page.goto(`${worldPath}/session`)
  await page.getByLabel('Name').fill('Calendar Session')
  await page.getByRole('button', { name: 'Add' }).click()
  await page.getByRole('link', { name: 'Calendar Session', exact: true }).click()
  // The date control lives in the editor, which a session page now opens with
  // collapsed.
  await openEntityEditor(page, 'session')
  await expect(page.getByLabel('Played at')).toBeVisible()
  await expect(page.getByLabel('Month')).toHaveCount(0)

  // Give the world a custom calendar and make it active.
  await openSettings(page)
  await addCalendar(page, 'Session Reckoning', 'Custom')
  await row(page, 'Session Reckoning')
    .getByRole('button', { name: 'Edit Session Reckoning' })
    .click()
  const form = panel(page).getByLabel('Configure Session Reckoning')
  await form.getByRole('button', { name: 'Add month' }).click()
  await form.getByLabel('Month 1 name').fill('Duskmoon')
  await form.getByLabel('Month 1 length').fill('30')
  await form.getByLabel('Eras').fill('SR')
  await form.getByRole('button', { name: 'Save calendar' }).click()
  await row(page, 'Session Reckoning')
    .getByRole('button', { name: 'Make Session Reckoning active' })
    .click()
  await expect(row(page, 'Session Reckoning').getByText('Active', { exact: true })).toBeVisible()

  // Now the session's date is a calendar-aware picker offering month NAMES.
  await page.goto(`${worldPath}/session`)
  await page.getByRole('link', { name: 'Calendar Session', exact: true }).click()
  await openEntityEditor(page, 'session')
  const month = page.getByLabel('Month')
  await expect(month).toBeVisible()
  await expect(month.locator('option')).toHaveCount(2) // the prompt + Duskmoon
  await page.getByLabel('Year').fill('1481')
  await month.selectOption({ label: 'Duskmoon (30 days)' })
  await page.getByLabel('Day').fill('9')

  // Rendered through the same `formatDate` the settings preview uses.
  await expect(page.getByText('Duskmoon 9, 1481 SR')).toBeVisible()
  await page.getByRole('button', { name: 'Save' }).first().click()

  // Stored as the plain ISO date it always was — the calendar changes how a date
  // READS, never how it is stored.
  await page.reload()
  await openEntityEditor(page, 'session')
  await expect(page.getByLabel('Year')).toHaveValue('1481')
  // Zero-padded, because that is how it is STORED — the controls read the column.
  await expect(page.getByLabel('Day')).toHaveValue('09')
  await expect(page.getByText('Duskmoon 9, 1481 SR')).toBeVisible()

  // Delete the calendar: the world is allowed back to having none, and the stored
  // date is still there behind the free-text field.
  await openSettings(page)
  await row(page, 'Session Reckoning')
    .getByRole('button', { name: 'Delete Session Reckoning' })
    .click()
  await expect(row(page, 'Session Reckoning')).toHaveCount(0)

  await page.goto(`${worldPath}/session`)
  await page.getByRole('link', { name: 'Calendar Session', exact: true }).click()
  await openEntityEditor(page, 'session')
  await expect(page.getByLabel('Month')).toHaveCount(0)
  // Duskmoon is the calendar's FIRST month, so the stored date is month 01.
  await expect(page.getByLabel('Played at')).toHaveValue('1481-01-09')
})

test('a player reads the world’s calendar and is offered nothing to change', async ({ page }) => {
  // Calendars are world config, so a player CAN read them — that is the decision,
  // not a leak. What they must not have is any control.
  await login(page, 'owner')
  await openSettings(page)
  await addCalendar(page, 'Player Visible Reckoning', 'Gregorian')

  await logout(page)
  await login(page, 'player1')
  await openSettings(page)

  await expect(row(page, 'Player Visible Reckoning')).toBeVisible()
  await expect(panel(page).getByLabel('New calendar')).toHaveCount(0)
  await expect(panel(page).getByRole('button', { name: /^Edit / })).toHaveCount(0)
  await expect(panel(page).getByRole('button', { name: /^Delete / })).toHaveCount(0)
  await expect(panel(page).getByRole('button', { name: /^Make / })).toHaveCount(0)
})
