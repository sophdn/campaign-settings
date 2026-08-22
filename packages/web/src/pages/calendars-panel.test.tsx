import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { type ApiClient, ApiClientError, type WorldCalendar } from '../api'
import { ApiProvider } from '../app/api-context'
import { makeApi } from '../testing/fake-api'
import { CalendarsPanel, toDraftConfig, toStoredConfig } from './calendars-panel'

const RECKONING: WorldCalendar = {
  id: 'cal1',
  name: 'Reckoning',
  kind: 'custom',
  config: {
    months: [
      { name: 'Frostmoon', days: 30 },
      { name: 'Thawmoon', days: 31 },
    ],
    weekdays: ['Firstday', 'Secondday'],
    eras: ['AR'],
    leap_year_rule: 'every eighth year',
  },
  isActive: true,
  isUserDefined: true,
}

const GREGORIAN: WorldCalendar = {
  id: 'cal2',
  name: 'Common Reckoning',
  kind: 'gregorian',
  config: {},
  isActive: false,
  isUserDefined: false,
}

function mount(
  calendars: WorldCalendar[],
  over: Partial<ApiClient> = {},
  canEdit = true,
): ApiClient {
  const api = makeApi({
    listCalendars: vi.fn(() => Promise.resolve(calendars)),
    ...over,
  })
  render(
    <ApiProvider value={api}>
      <CalendarsPanel worldId="w1" canEdit={canEdit} />
    </ApiProvider>,
  )
  return api
}

/** One calendar's row, so a badge query cannot match the form's own options. */
const row = (name: string): HTMLElement => screen.getByText(name).closest('li') as HTMLElement

/** 2026-01-15 through Reckoning: its first month is Frostmoon, its era AR. */
const SAMPLE = 'Frostmoon 15, 2026 AR'

describe('toDraftConfig / toStoredConfig', () => {
  it('round-trips a full config', () => {
    expect(toStoredConfig(toDraftConfig(RECKONING.config))).toEqual(RECKONING.config)
  })

  it('renders lists as comma-separated text and reads them back', () => {
    const draft = toDraftConfig(RECKONING.config)
    expect(draft.weekdays).toBe('Firstday, Secondday')
    expect(draft.eras).toBe('AR')
    expect(draft.months).toEqual([
      { name: 'Frostmoon', days: '30' },
      { name: 'Thawmoon', days: '31' },
    ])
  })

  it('omits every empty key rather than storing an empty list', () => {
    // So a gregorian calendar stores `{}` and a config never claims to define a
    // month list it does not have.
    expect(toStoredConfig(toDraftConfig({}))).toEqual({})
    expect(
      toStoredConfig({ months: [], weekdays: '  ,  ', eras: '', leapYearRule: '   ' }),
    ).toEqual({})
  })

  it('drops unnamed months and floors an unparseable length at 1', () => {
    // A month of zero or NaN days is not something a GM meant to write, and the
    // column's own floor is 1.
    expect(
      toStoredConfig({
        months: [
          { name: '  ', days: '30' },
          { name: 'Odd', days: 'abc' },
          { name: 'Zero', days: '0' },
          { name: ' Trimmed ', days: '28' },
        ],
        weekdays: '',
        eras: '',
        leapYearRule: '',
      }),
    ).toEqual({
      months: [
        { name: 'Odd', days: 1 },
        { name: 'Zero', days: 1 },
        { name: 'Trimmed', days: 28 },
      ],
    })
  })

  it('tolerates trailing and doubled separators in a list', () => {
    expect(
      toStoredConfig({ months: [], weekdays: 'Mon,, Tue, ', eras: '', leapYearRule: '' }),
    ).toEqual({ weekdays: ['Mon', 'Tue'] })
  })
})

describe('CalendarsPanel', () => {
  it('lists each calendar with its kind and marks the active one', async () => {
    mount([RECKONING, GREGORIAN])
    expect(await screen.findByText('Reckoning')).toBeTruthy()
    // Scoped to each row: "Custom" and "Gregorian" are also the new-calendar
    // form's own option labels, so an unscoped query matches those too.
    expect(within(row('Reckoning')).getByText('Custom')).toBeTruthy()
    expect(within(row('Reckoning')).getByText('Active')).toBeTruthy()
    expect(within(row('Common Reckoning')).getByText('Gregorian')).toBeTruthy()
    expect(within(row('Common Reckoning')).queryByText('Active')).toBeNull()
  })

  it('renders the config as structure, and a live sample through formatDate', async () => {
    mount([RECKONING])
    await screen.findByText('Reckoning')
    // The read view renders the month list AS a list, not as JSON.
    const months = within(row('Reckoning')).getByRole('list')
    expect(within(months).getAllByRole('listitem')).toHaveLength(2)
    expect(within(months).getByText(/Frostmoon/)).toBeTruthy()
    expect(within(months).getByText('(30 days)')).toBeTruthy()
    expect(screen.getByText('Weekdays: Firstday, Secondday')).toBeTruthy()
    expect(screen.getByText('Eras: AR')).toBeTruthy()
    expect(screen.getByText('Leap years: every eighth year')).toBeTruthy()

    // The sample is what makes a calendar legible at all.
    expect(screen.getByText(SAMPLE)).toBeTruthy()
  })

  it('says so plainly when the world has no calendar', async () => {
    mount([])
    expect(await screen.findByText(/No calendars yet/)).toBeTruthy()
  })

  it('adds a calendar and reloads the list', async () => {
    const createCalendar = vi.fn(() => Promise.resolve(RECKONING))
    const listCalendars = vi.fn(() => Promise.resolve([]))
    mount([], { createCalendar, listCalendars })

    fireEvent.change(await screen.findByLabelText('New calendar'), {
      target: { value: 'Reckoning' },
    })
    fireEvent.change(screen.getByLabelText('Calendar kind'), { target: { value: 'gregorian' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add calendar' }))

    await waitFor(() =>
      expect(createCalendar).toHaveBeenCalledWith('w1', { name: 'Reckoning', kind: 'gregorian' }),
    )
    await waitFor(() => expect(listCalendars).toHaveBeenCalledTimes(2))
  })

  it('will not add a calendar with no name', async () => {
    mount([])
    expect(await screen.findByRole('button', { name: 'Add calendar' })).toHaveProperty(
      'disabled',
      true,
    )
  })

  it('activates a calendar that is not already active', async () => {
    const activateCalendar = vi.fn(() => Promise.resolve([]))
    mount([RECKONING, GREGORIAN], { activateCalendar })

    // Offered for the inactive one only — activating the active one is a no-op.
    fireEvent.click(await screen.findByRole('button', { name: 'Make Common Reckoning active' }))
    await waitFor(() => expect(activateCalendar).toHaveBeenCalledWith('w1', 'cal2'))
    expect(screen.queryByRole('button', { name: 'Make Reckoning active' })).toBeNull()
  })

  it('deletes a calendar', async () => {
    const deleteCalendar = vi.fn(() => Promise.resolve())
    mount([RECKONING], { deleteCalendar })
    fireEvent.click(await screen.findByRole('button', { name: 'Delete Reckoning' }))
    await waitFor(() => expect(deleteCalendar).toHaveBeenCalledWith('w1', 'cal1'))
  })

  it('surfaces a refusal instead of failing silently', async () => {
    mount([RECKONING], {
      deleteCalendar: vi.fn(() =>
        Promise.reject(new ApiClientError(409, 'in_use', 'That calendar is in use')),
      ),
    })
    fireEvent.click(await screen.findByRole('button', { name: 'Delete Reckoning' }))
    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      'That calendar is in use',
    )
  })

  describe('the structured config editor', () => {
    it('edits months as name + length rather than as JSON', async () => {
      const updateCalendar = vi.fn(() => Promise.resolve(RECKONING))
      mount([RECKONING], { updateCalendar })
      fireEvent.click(await screen.findByRole('button', { name: 'Edit Reckoning' }))

      // Seeded from the stored config, as fields.
      expect(screen.getByLabelText('Month 1 name')).toHaveProperty('value', 'Frostmoon')
      expect(screen.getByLabelText('Month 1 length')).toHaveProperty('value', '30')
      // …and there is no JSON textarea anywhere in it.
      expect(screen.queryByRole('textbox', { name: /json/i })).toBeNull()

      fireEvent.change(screen.getByLabelText('Month 2 name'), { target: { value: 'Rainmoon' } })
      fireEvent.change(screen.getByLabelText('Month 2 length'), { target: { value: '29' } })
      fireEvent.click(screen.getByRole('button', { name: 'Save calendar' }))

      await waitFor(() =>
        expect(updateCalendar).toHaveBeenCalledWith('w1', 'cal1', {
          name: 'Reckoning',
          kind: 'custom',
          config: {
            months: [
              { name: 'Frostmoon', days: 30 },
              { name: 'Rainmoon', days: 29 },
            ],
            weekdays: ['Firstday', 'Secondday'],
            eras: ['AR'],
            leap_year_rule: 'every eighth year',
          },
        }),
      )
    })

    it('adds and removes month rows', async () => {
      mount([RECKONING])
      fireEvent.click(await screen.findByRole('button', { name: 'Edit Reckoning' }))

      fireEvent.click(screen.getByRole('button', { name: 'Add month' }))
      expect(screen.getByLabelText('Month 3 name')).toHaveProperty('value', '')
      expect(screen.getByLabelText('Month 3 length')).toHaveProperty('value', '30')

      fireEvent.click(screen.getByRole('button', { name: 'Remove month 1' }))
      // The list closes up, so what was month 2 is now month 1.
      expect(screen.getByLabelText('Month 1 name')).toHaveProperty('value', 'Thawmoon')
      expect(screen.queryByLabelText('Month 3 name')).toBeNull()
    })

    it('previews the UNSAVED draft, so a rename is visible before committing', async () => {
      mount([RECKONING])
      fireEvent.click(await screen.findByRole('button', { name: 'Edit Reckoning' }))

      expect(screen.getAllByText(SAMPLE).length).toBeGreaterThan(0)
      // Renaming the FIRST month is what the sample reads through.
      fireEvent.change(screen.getByLabelText('Month 1 name'), { target: { value: 'Rainmoon' } })
      expect(await screen.findByText('Rainmoon 15, 2026 AR')).toBeTruthy()
    })

    it('closes on save', async () => {
      mount([RECKONING], { updateCalendar: vi.fn(() => Promise.resolve(RECKONING)) })
      fireEvent.click(await screen.findByRole('button', { name: 'Edit Reckoning' }))
      expect(screen.getByLabelText('Month 1 name')).toBeTruthy()
      fireEvent.click(screen.getByRole('button', { name: 'Save calendar' }))
      await waitFor(() => expect(screen.queryByLabelText('Month 1 name')).toBeNull())
    })

    it('toggles shut again without saving', async () => {
      mount([RECKONING])
      fireEvent.click(await screen.findByRole('button', { name: 'Edit Reckoning' }))
      fireEvent.click(screen.getByRole('button', { name: 'Close Reckoning' }))
      expect(screen.queryByLabelText('Month 1 name')).toBeNull()
    })

    it('surfaces a save refusal', async () => {
      mount([RECKONING], {
        updateCalendar: vi.fn(() => Promise.reject(new ApiClientError(400, 'bad', 'Bad config'))),
      })
      fireEvent.click(await screen.findByRole('button', { name: 'Edit Reckoning' }))
      fireEvent.click(screen.getByRole('button', { name: 'Save calendar' }))
      expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Bad config')
    })
  })

  describe('a player', () => {
    it('reads the calendar but is offered no control at all', async () => {
      // Calendars are world config: readable by every member, writable by the GM.
      mount([RECKONING], {}, false)
      expect(await screen.findByText('Reckoning')).toBeTruthy()
      expect(screen.getByText(SAMPLE)).toBeTruthy()

      expect(screen.queryByLabelText('New calendar')).toBeNull()
      expect(screen.queryByRole('button', { name: 'Edit Reckoning' })).toBeNull()
      expect(screen.queryByRole('button', { name: 'Delete Reckoning' })).toBeNull()
      expect(screen.queryByRole('button', { name: /Make .* active/ })).toBeNull()
    })

    it('is told plainly when the world has no calendar', async () => {
      mount([], {}, false)
      expect(await screen.findByText('No calendar has been set for this world.')).toBeTruthy()
    })
  })
})
