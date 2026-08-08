import { describe, expect, it } from 'vitest'
import { type CalendarShape, formatDate } from './calendar'

const gregorian: CalendarShape = { kind: 'gregorian', config: {} }
const custom: CalendarShape = {
  kind: 'custom',
  config: {
    months: [
      { name: 'Frostmoon', days: 30 },
      { name: 'Thawmoon', days: 30 },
    ],
    eras: ['YK'],
  },
}

describe('formatDate', () => {
  it('returns the input unchanged for a gregorian calendar', () => {
    expect(formatDate('2026-06-25', gregorian)).toBe('2026-06-25')
  })

  it('renders a custom calendar date with month name, day, year and era', () => {
    expect(formatDate('0412-02-09', custom)).toBe('Thawmoon 9, 412 YK')
  })

  it('falls back to the numeric month when the config has no such month', () => {
    expect(formatDate('0412-11-09', custom)).toBe('11 9, 412 YK')
  })

  it('omits the era when none is configured', () => {
    expect(
      formatDate('0001-01-01', {
        kind: 'custom',
        config: { months: [{ name: 'Firstmoon', days: 30 }] },
      }),
    ).toBe('Firstmoon 1, 1')
  })

  it('falls back to the numeric month when the calendar defines no months at all', () => {
    expect(formatDate('0412-02-09', { kind: 'custom', config: { eras: ['YK'] } })).toBe(
      '02 9, 412 YK',
    )
  })

  it('passes non-ISO input through unchanged', () => {
    expect(formatDate('the third age', custom)).toBe('the third age')
  })
})
