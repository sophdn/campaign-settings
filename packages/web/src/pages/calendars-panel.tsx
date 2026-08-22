import { type CalendarConfig, type CalendarKind, formatDate } from '@campaign-settings/shared'
import { useCallback, useState } from 'react'
import type { WorldCalendar } from '../api'
import { useApi } from '../app/api-context'
import { errorMessage } from '../app/error-message'
import { useResource } from '../app/use-resource'
import { Badge } from '../components/badge'
import { Button } from '../components/button'
import { SelectField, TextField } from '../components/field'
import { Panel } from '../components/panel'
import { EmptyState } from '../components/status'

/**
 * A world's calendars, on the settings page because that is what they are.
 *
 * Calendars sit OUTSIDE the content-authorization seam by decision, not omission:
 * they are world configuration, like the world's name — every member reads them,
 * only the GM changes them. So this panel lives beside the rename form rather than
 * on an entity page, and there is no visibility control on it to render.
 *
 * ## The config is edited as STRUCTURE, never as JSON
 *
 * Months, weekdays and eras get real inputs. A raw JSON textarea was the cheap
 * option and it is the wrong one: it makes a schema the GM has to know, turns a
 * typo into a parse error instead of a fixable field, and offers no way to render
 * a month list as a month list. The shape it produces is the same
 * `CalendarConfig` the importer already fills from dm-manager.
 *
 * ## The sample is the read view
 *
 * Every custom calendar shows a live `formatDate` of a real date through itself.
 * That is the only way to see what a calendar DOES — nothing computes off one, so
 * a config with no sample is just a list of words. The formatting comes from
 * `shared/calendar.ts`, the same function the session date field uses, so the
 * preview here cannot disagree with what a session page shows.
 */

/** A month mid-edit: `days` is a raw string until it is saved. */
interface DraftMonth {
  name: string
  days: string
}

/** The whole config mid-edit — lists as strings, so a half-typed row is legal. */
interface DraftConfig {
  months: DraftMonth[]
  /** Comma-separated. A weekday list is short and flat; a row per name is noise. */
  weekdays: string
  eras: string
  leapYearRule: string
}

/*
  The date every preview is rendered through. In the FIRST month deliberately:
  `formatDate` looks the month up by its 1-based number and falls back to the raw
  number when the calendar has no month there, so a later date (March, say) would
  preview as "03 15, 2026" for every calendar with fewer than three months — the
  preview would look broken exactly when the GM has only started filling one in.
*/
const SAMPLE_DATE = '2026-01-15'

export function toDraftConfig(config: CalendarConfig): DraftConfig {
  return {
    months: (config.months ?? []).map((m) => ({ name: m.name, days: String(m.days) })),
    weekdays: (config.weekdays ?? []).join(', '),
    eras: (config.eras ?? []).join(', '),
    leapYearRule: config.leap_year_rule ?? '',
  }
}

/** Split a comma-separated list, dropping blanks so trailing commas are harmless. */
function toList(raw: string): string[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '')
}

/**
 * Drafts back to the stored shape.
 *
 * Every key is omitted when empty rather than written as `[]`, so a gregorian
 * calendar stores `{}` and a config never claims to define a month list it does
 * not have. An unparseable month length becomes 1 — the column's floor — because
 * a month of zero or NaN days is not a thing a GM meant to write.
 */
export function toStoredConfig(draft: DraftConfig): CalendarConfig {
  const months = draft.months
    .filter((m) => m.name.trim() !== '')
    .map((m) => {
      const n = Number.parseInt(m.days, 10)
      return { name: m.name.trim(), days: Number.isFinite(n) && n > 0 ? n : 1 }
    })
  const weekdays = toList(draft.weekdays)
  const eras = toList(draft.eras)
  const rule = draft.leapYearRule.trim()
  return {
    ...(months.length === 0 ? {} : { months }),
    ...(weekdays.length === 0 ? {} : { weekdays }),
    ...(eras.length === 0 ? {} : { eras }),
    ...(rule === '' ? {} : { leap_year_rule: rule }),
  }
}

export function CalendarsPanel({
  worldId,
  canEdit,
}: {
  worldId: string
  canEdit: boolean
}): React.JSX.Element {
  const api = useApi()
  const fetcher = useCallback(() => api.listCalendars(worldId), [api, worldId])
  const { data, reload } = useResource(fetcher)
  const calendars = data ?? []

  return (
    <Panel ariaLabel="Calendars">
      <h3>Calendars</h3>
      <p className="field-hint">
        The date scheme this world&rsquo;s sessions are written in. Every player can read it; only
        you can change it. Exactly one is active at a time.
      </p>

      {canEdit ? <NewCalendarForm worldId={worldId} onCreated={reload} /> : null}

      {calendars.length === 0 ? (
        <EmptyState>
          {canEdit
            ? 'No calendars yet. Add one above, then make it active to date sessions with it.'
            : 'No calendar has been set for this world.'}
        </EmptyState>
      ) : (
        <ul className="calendar-list">
          {calendars.map((c) => (
            <CalendarRow
              key={c.id}
              worldId={worldId}
              calendar={c}
              canEdit={canEdit}
              onChanged={reload}
            />
          ))}
        </ul>
      )}
    </Panel>
  )
}

function CalendarRow({
  worldId,
  calendar,
  canEdit,
  onChanged,
}: {
  worldId: string
  calendar: WorldCalendar
  canEdit: boolean
  onChanged: () => void
}): React.JSX.Element {
  const api = useApi()
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function run(fn: () => Promise<unknown>, fallback: string): Promise<void> {
    setError(null)
    try {
      await fn()
      onChanged()
    } catch (err) {
      setError(errorMessage(err, fallback))
    }
  }

  return (
    <li className="calendar-row">
      <div className="calendar-row-head">
        <strong>{calendar.name}</strong>
        <Badge>{calendar.kind === 'custom' ? 'Custom' : 'Gregorian'}</Badge>
        {calendar.isActive ? <Badge className="calendar-active">Active</Badge> : null}
        {canEdit ? (
          <>
            {calendar.isActive ? null : (
              <Button
                type="button"
                variant="secondary"
                aria-label={`Make ${calendar.name} active`}
                onClick={() =>
                  void run(
                    () => api.activateCalendar(worldId, calendar.id),
                    'Could not activate this calendar',
                  )
                }
              >
                Make active
              </Button>
            )}
            <Button
              type="button"
              variant="secondary"
              // The accessible name tracks what the button DOES now. An
              // aria-label overrides the text, so a fixed "Edit …" would leave a
              // screen reader announcing Edit while the control closes the form.
              aria-label={`${open ? 'Close' : 'Edit'} ${calendar.name}`}
              onClick={() => setOpen((v) => !v)}
            >
              {open ? 'Close' : 'Edit'}
            </Button>
            <Button
              type="button"
              variant="danger"
              aria-label={`Delete ${calendar.name}`}
              onClick={() =>
                void run(
                  () => api.deleteCalendar(worldId, calendar.id),
                  'Could not delete this calendar',
                )
              }
            >
              Delete
            </Button>
          </>
        ) : null}
      </div>

      <CalendarReadView calendar={calendar} />
      {open ? (
        <ConfigEditor
          worldId={worldId}
          calendar={calendar}
          onSaved={() => {
            setOpen(false)
            onChanged()
          }}
        />
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
    </li>
  )
}

/**
 * What a calendar IS, rendered rather than described — the month list as a list,
 * and a real date put through `formatDate` so the scheme is visible at a glance.
 */
export function CalendarReadView({ calendar }: { calendar: WorldCalendar }): React.JSX.Element {
  const { months, weekdays, eras, leap_year_rule: rule } = calendar.config
  const sample = formatDate(SAMPLE_DATE, { kind: calendar.kind, config: calendar.config })
  return (
    <div className="calendar-read">
      <p className="calendar-sample">
        <span className="field-hint">{SAMPLE_DATE} reads as</span> <strong>{sample}</strong>
      </p>
      {months && months.length > 0 ? (
        <ol className="calendar-months">
          {months.map((m, i) => (
            <li key={`${m.name}-${i}`}>
              {m.name} <span className="muted">({m.days} days)</span>
            </li>
          ))}
        </ol>
      ) : null}
      {weekdays && weekdays.length > 0 ? <p>Weekdays: {weekdays.join(', ')}</p> : null}
      {eras && eras.length > 0 ? <p>Eras: {eras.join(', ')}</p> : null}
      {rule ? <p>Leap years: {rule}</p> : null}
    </div>
  )
}

function NewCalendarForm({
  worldId,
  onCreated,
}: {
  worldId: string
  onCreated: () => void
}): React.JSX.Element {
  const api = useApi()
  const [name, setName] = useState('')
  const [kind, setKind] = useState<CalendarKind>('custom')
  const [error, setError] = useState<string | null>(null)

  async function onSubmit(): Promise<void> {
    setError(null)
    try {
      await api.createCalendar(worldId, { name: name.trim(), kind })
      setName('')
      onCreated()
    } catch (err) {
      setError(errorMessage(err, 'Could not add the calendar'))
    }
  }

  return (
    <div className="calendar-form">
      <TextField
        label="New calendar"
        value={name}
        onChange={setName}
        placeholder="e.g. Reckoning"
      />
      <SelectField
        label="Kind"
        ariaLabel="Calendar kind"
        value={kind}
        onChange={(v) => setKind(v as CalendarKind)}
        hint="Gregorian shows dates as written. Custom renders them through months you define."
        options={[
          { value: 'custom', label: 'Custom' },
          { value: 'gregorian', label: 'Gregorian' },
        ]}
      />
      <Button type="button" disabled={name.trim() === ''} onClick={() => void onSubmit()}>
        Add calendar
      </Button>
      {error ? <p role="alert">{error}</p> : null}
    </div>
  )
}

/** The structured editor. Months get a row each; weekdays and eras are flat lists. */
function ConfigEditor({
  worldId,
  calendar,
  onSaved,
}: {
  worldId: string
  calendar: WorldCalendar
  onSaved: () => void
}): React.JSX.Element {
  const api = useApi()
  const [draft, setDraft] = useState<DraftConfig>(() => toDraftConfig(calendar.config))
  const [name, setName] = useState(calendar.name)
  const [kind, setKind] = useState<CalendarKind>(calendar.kind)
  const [error, setError] = useState<string | null>(null)

  const setMonth = (i: number, patch: Partial<DraftMonth>): void =>
    setDraft((d) => ({
      ...d,
      months: d.months.map((m, j) => (j === i ? { ...m, ...patch } : m)),
    }))

  async function onSave(): Promise<void> {
    setError(null)
    try {
      await api.updateCalendar(worldId, calendar.id, {
        name: name.trim(),
        kind,
        config: toStoredConfig(draft),
      })
      onSaved()
    } catch (err) {
      setError(errorMessage(err, 'Could not save the calendar'))
    }
  }

  // The same preview the read view shows, but of the UNSAVED draft — so the GM
  // sees what a month rename does before committing it.
  const preview = formatDate(SAMPLE_DATE, { kind, config: toStoredConfig(draft) })

  return (
    <div className="calendar-config" aria-label={`Configure ${calendar.name}`}>
      <TextField label="Name" value={name} onChange={setName} />
      <SelectField
        label="Kind"
        ariaLabel={`Kind of ${calendar.name}`}
        value={kind}
        onChange={(v) => setKind(v as CalendarKind)}
        options={[
          { value: 'custom', label: 'Custom' },
          { value: 'gregorian', label: 'Gregorian' },
        ]}
      />

      <h4>Months</h4>
      {draft.months.map((m, i) => (
        // Index-keyed deliberately: a month has no identity while it is being
        // typed, and keying on the name would remount the input every keystroke.
        <div className="calendar-month-row" key={i}>
          <TextField
            label={`Month ${i + 1} name`}
            value={m.name}
            onChange={(v) => setMonth(i, { name: v })}
          />
          <TextField
            label={`Month ${i + 1} length`}
            value={m.days}
            type="number"
            onChange={(v) => setMonth(i, { days: v })}
          />
          <Button
            type="button"
            variant="danger"
            aria-label={`Remove month ${i + 1}`}
            onClick={() => setDraft((d) => ({ ...d, months: d.months.filter((_, j) => j !== i) }))}
          >
            Remove
          </Button>
        </div>
      ))}
      <Button
        type="button"
        variant="secondary"
        onClick={() => setDraft((d) => ({ ...d, months: [...d.months, { name: '', days: '30' }] }))}
      >
        Add month
      </Button>

      <TextField
        label="Weekdays"
        value={draft.weekdays}
        hint="Comma-separated, in order."
        onChange={(v) => setDraft((d) => ({ ...d, weekdays: v }))}
      />
      <TextField
        label="Eras"
        value={draft.eras}
        hint="Comma-separated. The first is appended to formatted dates."
        onChange={(v) => setDraft((d) => ({ ...d, eras: v }))}
      />
      <TextField
        label="Leap years"
        value={draft.leapYearRule}
        hint="Recorded as prose — nothing computes with it."
        onChange={(v) => setDraft((d) => ({ ...d, leapYearRule: v }))}
      />

      <p className="calendar-sample">
        <span className="field-hint">{SAMPLE_DATE} will read as</span> <strong>{preview}</strong>
      </p>
      <div className="form-actions">
        <Button type="button" onClick={() => void onSave()}>
          Save calendar
        </Button>
      </div>
      {error ? <p role="alert">{error}</p> : null}
    </div>
  )
}
