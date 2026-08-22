import { formatDate } from '@campaign-settings/shared'
import { useCallback, useState } from 'react'
import { useApi } from '../app/api-context'
import { useResource } from '../app/use-resource'
import { SelectField, TextField } from '../components/field'

/**
 * A session's `played_at`, rendered against the world's ACTIVE calendar.
 *
 * ## Why this fetches for itself
 *
 * The field only exists on a session, so the active-calendar read lives here
 * rather than on the detail page — hoisting it would make every entity page of
 * every kind fetch a calendar it has no use for.
 *
 * ## Three states, and the fallback is a feature
 *
 * NO ACTIVE CALENDAR → the plain free-text field, unchanged from what sessions had
 * before calendars were wired to anything. That is deliberate: a world with no
 * calendar (or one whose calendar was deleted) must stay editable, and a GM who
 * writes "the third Tuesday after the flood" is not making a mistake this field
 * should refuse. Same for the loading tick, so the input never disappears and
 * reappears under the cursor.
 *
 * GREGORIAN → a native date input. The stored value is already ISO, which is
 * exactly what `input[type=date]` reads and writes, so this is a better control
 * over the identical string.
 *
 * CUSTOM → year, month and day as separate controls, because the month NAMES come
 * from the calendar's config and a text field cannot offer them. They compose back
 * into the same `YYYY-MM-DD` the column has always held: the calendar changes how a
 * date READS, never how it is stored, which is what keeps it decorative and keeps
 * a stored date meaningful after the GM switches calendars.
 *
 * Every state stores the same shape, so switching calendars never rewrites data.
 */

/** Split a stored `YYYY-MM-DD` into parts. Anything else yields empty parts. */
export function splitIsoDate(value: string): { year: string; month: string; day: string } {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!m) return { year: '', month: '', day: '' }
  return { year: m[1] ?? '', month: m[2] ?? '', day: m[3] ?? '' }
}

/**
 * Parts back into a stored date.
 *
 * Returns '' until all three are present, so a half-built date is never saved as
 * `0000-01-01`. Month and day are zero-padded because the stored format is fixed
 * and `formatDate` parses it strictly.
 */
export function joinIsoDate(year: string, month: string, day: string): string {
  if (year === '' || month === '' || day === '') return ''
  return `${year.padStart(4, '0')}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`
}

export function SessionDateField({
  worldId,
  value,
  onChange,
}: {
  worldId: string
  value: string
  onChange: (value: string) => void
}): React.JSX.Element {
  const api = useApi()
  const fetcher = useCallback(() => api.activeCalendar(worldId), [api, worldId])
  const { data: calendar, loading } = useResource(fetcher)

  if (loading || !calendar) {
    return (
      <TextField
        label="Played at"
        value={value}
        onChange={onChange}
        placeholder="e.g. 2026-06-27"
      />
    )
  }

  if (calendar.kind === 'gregorian') {
    return (
      <TextField
        label="Played at"
        value={value}
        type="date"
        hint={`Dated by ${calendar.name}.`}
        onChange={onChange}
      />
    )
  }

  const months = calendar.config.months ?? []

  // With no months defined there is nothing to pick from, so a custom calendar
  // that has not been filled in yet behaves like no calendar rather than offering
  // an empty dropdown.
  if (months.length === 0) {
    return (
      <TextField
        label="Played at"
        value={value}
        hint={`${calendar.name} has no months defined yet.`}
        onChange={onChange}
      />
    )
  }

  return <CustomDatePicker calendar={calendar} months={months} value={value} onChange={onChange} />
}

/**
 * The three-control picker, which needs state of its OWN.
 *
 * A stored date is all-or-nothing — `joinIsoDate` returns '' until year, month and
 * day are all present, because a half-built date must never save as `0000-01-01`.
 * So the parts cannot be derived from the stored value alone: typing the year would
 * compose to '', the field would re-derive from '' and the keystroke would vanish.
 * That is not hypothetical; it is what the e2e spec caught.
 *
 * So the parts live here and only a COMPLETE date is pushed up. `emitted` tracks
 * what was last sent so an incoming value that we did not produce — the parent
 * loading a different session, or a reload — re-seeds the controls, while our own
 * intermediate '' does not wipe what is being typed.
 */
function CustomDatePicker({
  calendar,
  months,
  value,
  onChange,
}: {
  calendar: {
    name: string
    kind: 'gregorian' | 'custom'
    config: { months?: Array<{ name: string; days: number }> }
  }
  months: Array<{ name: string; days: number }>
  value: string
  onChange: (value: string) => void
}): React.JSX.Element {
  const [parts, setParts] = useState(() => splitIsoDate(value))
  const [emitted, setEmitted] = useState(value)

  if (value !== emitted) {
    setEmitted(value)
    setParts(splitIsoDate(value))
  }

  const update = (patch: Partial<typeof parts>): void => {
    const next = { ...parts, ...patch }
    const joined = joinIsoDate(next.year, next.month, next.day)
    setParts(next)
    setEmitted(joined)
    onChange(joined)
  }

  const complete = joinIsoDate(parts.year, parts.month, parts.day)

  return (
    <div className="session-date" aria-label="Played at">
      <TextField
        label="Year"
        value={parts.year}
        type="number"
        onChange={(v) => update({ year: v })}
      />
      <SelectField
        label="Month"
        ariaLabel="Month"
        value={parts.month}
        onChange={(v) => update({ month: v })}
        options={[
          { value: '', label: 'Choose a month…' },
          ...months.map((m, i) => ({
            // The stored month is a 1-based number; the NAME is presentation, so a
            // month rename never has to touch a session's stored date.
            value: String(i + 1).padStart(2, '0'),
            label: `${m.name} (${m.days} days)`,
          })),
        ]}
      />
      <TextField label="Day" value={parts.day} type="number" onChange={(v) => update({ day: v })} />
      {/* Only once the date is whole — half a date has nothing to read as. */}
      {complete === '' ? null : (
        <p className="calendar-sample">
          <span className="field-hint">Reads as</span>{' '}
          <strong>{formatDate(complete, { kind: calendar.kind, config: calendar.config })}</strong>
        </p>
      )}
    </div>
  )
}
