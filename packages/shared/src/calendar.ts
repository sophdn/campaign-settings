/**
 * Calendar date rendering — the pure `formatDate` from dm-manager (the calendar
 * storage/CRUD stays server-side). Decorative: nothing ticks on calendars.
 */

export type CalendarKind = 'gregorian' | 'custom'

/** JSON config carried on a calendar. Custom calendars populate these. */
export interface CalendarConfig {
  months?: Array<{ name: string; days: number }>
  weekdays?: string[]
  eras?: string[]
  leap_year_rule?: string
}

/** The fields `formatDate` needs from a calendar. */
export interface CalendarShape {
  kind: CalendarKind
  config: CalendarConfig
}

/**
 * Render an ISO-8601-shaped date string against a calendar.
 *
 * Gregorian: returns the input unchanged (already ISO). Custom: parses
 * `YYYY-MM-DD` and renders `<month name> <day>, <year>` plus the first era if
 * defined; non-ISO input passes through unchanged (no calendar-arithmetic in
 * v1). Pure.
 */
export function formatDate(dateString: string, calendar: CalendarShape): string {
  if (calendar.kind === 'gregorian') return dateString
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateString)
  if (!m) return dateString
  const monthStr = m[2] ?? ''
  const year = Number(m[1])
  const monthIdx = Number(monthStr) - 1
  const day = Number(m[3])
  const monthName = calendar.config.months?.[monthIdx]?.name ?? monthStr
  const era = calendar.config.eras?.[0] ?? ''
  return era ? `${monthName} ${day}, ${year} ${era}` : `${monthName} ${day}, ${year}`
}
