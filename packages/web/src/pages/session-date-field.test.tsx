import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ApiClient, WorldCalendar } from '../api'
import { ApiProvider } from '../app/api-context'
import { makeApi } from '../testing/fake-api'
import { joinIsoDate, SessionDateField, splitIsoDate } from './session-date-field'

const RECKONING: WorldCalendar = {
  id: 'cal1',
  name: 'Reckoning',
  kind: 'custom',
  config: {
    months: [
      { name: 'Frostmoon', days: 30 },
      { name: 'Thawmoon', days: 31 },
      { name: 'Sunmoon', days: 30 },
    ],
    eras: ['AR'],
  },
  isActive: true,
  isUserDefined: true,
}

const GREGORIAN: WorldCalendar = {
  id: 'cal2',
  name: 'Common Reckoning',
  kind: 'gregorian',
  config: {},
  isActive: true,
  isUserDefined: false,
}

function mount(calendar: WorldCalendar | null, value = ''): { onChange: (v: string) => void } {
  const onChange = vi.fn()
  const api: ApiClient = makeApi({ activeCalendar: vi.fn(() => Promise.resolve(calendar)) })
  render(
    <ApiProvider value={api}>
      <SessionDateField worldId="w1" value={value} onChange={onChange} />
    </ApiProvider>,
  )
  return { onChange }
}

describe('splitIsoDate / joinIsoDate', () => {
  it('round-trips a stored date', () => {
    expect(splitIsoDate('2026-03-14')).toEqual({ year: '2026', month: '03', day: '14' })
    expect(joinIsoDate('2026', '03', '14')).toBe('2026-03-14')
  })

  it('reads anything that is not YYYY-MM-DD as empty parts', () => {
    // A GM may have written "the third Tuesday after the flood". The parts are
    // empty rather than guessed, and the free-text path keeps such a value.
    for (const odd of ['', 'sometime', '2026', '2026-3-14', '14/03/2026']) {
      expect(splitIsoDate(odd)).toEqual({ year: '', month: '', day: '' })
    }
  })

  it('returns nothing until all three parts are present', () => {
    // Otherwise a half-built date saves as something like 0000-01-01.
    expect(joinIsoDate('', '03', '14')).toBe('')
    expect(joinIsoDate('2026', '', '14')).toBe('')
    expect(joinIsoDate('2026', '03', '')).toBe('')
  })

  it('zero-pads, because the stored format is fixed and parsed strictly', () => {
    expect(joinIsoDate('26', '3', '4')).toBe('0026-03-04')
  })
})

describe('SessionDateField', () => {
  it('falls back to a free-text field when the world has NO active calendar', async () => {
    const { onChange } = mount(null)
    const input = await screen.findByLabelText('Played at')
    // The attribute, not the property: jsdom does not implement date inputs and
    // reflects `type` back as "text" regardless of what was rendered.
    expect(input.getAttribute('type')).toBeNull()

    // And it stays free text: a world with no calendar must remain editable.
    fireEvent.change(input, { target: { value: 'the third Tuesday after the flood' } })
    expect(onChange).toHaveBeenCalledWith('the third Tuesday after the flood')
  })

  it('shows the free-text field while the calendar is still loading', () => {
    // Never absent-then-present: the input must not vanish under the cursor.
    const pending = new Promise<WorldCalendar | null>(() => {})
    const api: ApiClient = makeApi({ activeCalendar: vi.fn(() => pending) })
    render(
      <ApiProvider value={api}>
        <SessionDateField worldId="w1" value="2026-06-27" onChange={vi.fn()} />
      </ApiProvider>,
    )
    expect(screen.getByLabelText('Played at')).toHaveProperty('value', '2026-06-27')
  })

  it('offers a native date input for a gregorian calendar', async () => {
    mount(GREGORIAN, '2026-06-27')
    // Re-queried inside the wait, not captured before it: the loading fallback and
    // the loaded control are different elements, so a held reference goes stale.
    await waitFor(() =>
      expect(screen.getByLabelText('Played at').getAttribute('type')).toBe('date'),
    )
    // The stored value is already ISO, so this is a better control over the same
    // string rather than a different format.
    expect(screen.getByLabelText('Played at')).toHaveProperty('value', '2026-06-27')
  })

  it('offers year, month NAMES and day for a custom calendar', async () => {
    mount(RECKONING, '2026-03-14')
    const month = (await screen.findByLabelText('Month')) as HTMLSelectElement

    expect([...month.options].map((o) => o.textContent)).toEqual([
      'Choose a month…',
      'Frostmoon (30 days)',
      'Thawmoon (31 days)',
      'Sunmoon (30 days)',
    ])
    // The stored month is the 1-based NUMBER; the name is presentation only, so
    // renaming a month never rewrites a session's date.
    expect(month.value).toBe('03')
    expect(screen.getByLabelText('Year')).toHaveProperty('value', '2026')
    expect(screen.getByLabelText('Day')).toHaveProperty('value', '14')
  })

  it('renders the date through the calendar so the GM sees what it says', async () => {
    mount(RECKONING, '2026-03-14')
    // formatDate from `shared` — the same function the settings preview uses, so
    // the two surfaces cannot disagree.
    expect(await screen.findByText('Sunmoon 14, 2026 AR')).toBeTruthy()
  })

  it('composes each part back into the stored YYYY-MM-DD', async () => {
    const { onChange } = mount(RECKONING, '2026-03-14')
    await screen.findByLabelText('Month')

    fireEvent.change(screen.getByLabelText('Year'), { target: { value: '1204' } })
    expect(onChange).toHaveBeenLastCalledWith('1204-03-14')

    fireEvent.change(screen.getByLabelText('Month'), { target: { value: '01' } })
    expect(onChange).toHaveBeenLastCalledWith('2026-01-14')

    fireEvent.change(screen.getByLabelText('Day'), { target: { value: '2' } })
    expect(onChange).toHaveBeenLastCalledWith('2026-03-02')
  })

  it('starts from empty parts when the stored value is not a date', async () => {
    const { onChange } = mount(RECKONING, 'sometime in spring')
    await screen.findByLabelText('Month')
    expect(screen.getByLabelText('Year')).toHaveProperty('value', '')

    // Picking one part alone does not fabricate a date.
    fireEvent.change(screen.getByLabelText('Month'), { target: { value: '02' } })
    expect(onChange).toHaveBeenLastCalledWith('')
  })

  it('falls back to free text for a custom calendar with no months yet', async () => {
    // An empty dropdown is worse than the plain field it replaced.
    mount({ ...RECKONING, config: {} }, '2026-03-14')
    const input = await screen.findByLabelText('Played at')
    expect(input).toHaveProperty('value', '2026-03-14')
    expect(screen.queryByLabelText('Month')).toBeNull()
    expect(within(input.closest('label') as HTMLElement).queryByRole('combobox')).toBeNull()
  })
})
