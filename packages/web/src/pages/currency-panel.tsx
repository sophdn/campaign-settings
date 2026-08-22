import type { Denomination } from '@campaign-settings/shared'
import { useCallback, useState } from 'react'
import { Link } from 'react-router-dom'
import type { ApiClient, Entity } from '../api'
import { errorMessage } from '../app/error-message'
import { useResource } from '../app/use-resource'
import { Button } from '../components/button'
import { SelectField, TextField } from '../components/field'
import { Panel } from '../components/panel'

/**
 * The two parts of a currency the generic registry cannot express.
 *
 * DENOMINATIONS are a JSON array — sub-units with a multiplier relative to the
 * base unit — so they need row add/remove rather than one input.
 *
 * THE EXCHANGE ANCHOR is one coupled control, not two fields: a rate means
 * nothing without an anchor (dm-manager clears it when the anchor goes), and an
 * anchor's validity depends on every other currency in the world — it may not
 * be itself and the chain may not cycle. `shared/currency-rules.validateBaseRate`
 * holds that rule and the SERVER enforces it, which is where a data-integrity
 * invariant belongs; this surfaces the refusal rather than restating the rule.
 */

/** A denomination mid-edit: the multiplier is a raw string until it is saved. */
interface DraftDenomination {
  name: string
  multiplier: string
}

// The seed values for the editable state, as functions rather than inline
// expressions, because they are needed in TWO places — the initial mount and the
// re-seed when the page moves to another currency (see below). Two copies of
// `entity.rate === null ? '' : …` would be two chances to diverge, and each copy
// carries its own branches for the coverage gate to demand tests for.
const anchorOf = (entity: Entity): string => String(entity.base_rate_to ?? '')
const rateOf = (entity: Entity): string => (entity.rate === null ? '' : String(entity.rate ?? ''))

/** Read the stored JSON array into editable drafts, ignoring malformed rows. */
export function toDrafts(raw: unknown): DraftDenomination[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((row) => {
    if (typeof row !== 'object' || row === null) return []
    const d = row as Record<string, unknown>
    if (typeof d.name !== 'string') return []
    return [{ name: d.name, multiplier: String(d.multiplier ?? '') }]
  })
}

/**
 * Drafts back to the stored shape: `{name, multiplier}` with a numeric
 * multiplier, dropping unnamed rows. Matches dm-manager exactly, because the
 * importer copies its blob across verbatim and a second shape here would make
 * imported and app-authored currencies read differently.
 */
export function toStored(drafts: readonly DraftDenomination[]): Denomination[] {
  return drafts
    .filter((d) => d.name.trim() !== '')
    .map((d) => {
      const n = Number.parseFloat(d.multiplier)
      return { name: d.name.trim(), multiplier: Number.isFinite(n) ? n : 0 }
    })
}

export function CurrencyPanel({
  api,
  worldId,
  entity,
  canEdit,
  onSaved,
}: {
  api: ApiClient
  worldId: string
  entity: Entity
  canEdit: boolean
  onSaved: () => void
}): React.JSX.Element {
  const listCurrencies = useCallback(() => api.listEntities(worldId, 'currency'), [api, worldId])
  const { data: currencies } = useResource(listCurrencies)

  const [drafts, setDrafts] = useState<DraftDenomination[]>(() => toDrafts(entity.denominations))
  const [anchor, setAnchor] = useState(() => anchorOf(entity))
  const [rate, setRate] = useState(() => rateOf(entity))
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  /*
    RE-SEEDING WHEN THE PAGE MOVES TO ANOTHER CURRENCY, and why it is done here
    rather than with a `key` on the render site.

    This panel used to be mounted as `<CurrencyPanel key={entity.id} …>`, so a
    different id was a remount and the `useState` initialisers ran again. That
    worked in jsdom and duplicated the panel in a real browser: on the built SPA
    the detail route ended up holding two, three, or four
    `section[aria-label="Currency"]` siblings, all but the last INERT — their
    buttons did nothing and their state stayed frozen at the pre-fetch value
    (bug 1221). Removing the key removes the duplication, reproducibly, and a
    key on a sibling panel on the same page does NOT reproduce it, so this is
    specific to the combination rather than to keys in general. The React-level
    reason the superseded DOM is not unmounted is NOT established — what is
    established is which change makes it stop.

    Adjusting state during render is React's documented answer to "reset state
    when a prop changes", and it is not the effect the previous comment rightly
    warned about: it runs BEFORE children render (so no flash of the old
    currency's rows), and it fires only when the ENTITY IDENTITY changes — never
    when the parent merely refetches the same currency, which is what would have
    discarded half-typed rows.
  */
  const [seededFor, setSeededFor] = useState(entity.id)
  if (seededFor !== entity.id) {
    setSeededFor(entity.id)
    setDrafts(toDrafts(entity.denominations))
    setAnchor(anchorOf(entity))
    setRate(rateOf(entity))
    setStatus(null)
    setError(null)
  }

  const others = (currencies ?? []).filter((c) => c.id !== entity.id)
  const anchorTarget = (currencies ?? []).find((c) => c.id === anchor)

  async function onSave(): Promise<void> {
    setStatus(null)
    setError(null)
    try {
      await api.updateEntity(worldId, 'currency', entity.id, {
        denominations: toStored(drafts),
        base_rate_to: anchor === '' ? null : anchor,
        // A rate without an anchor is meaningless, so dropping the anchor
        // clears it rather than leaving a number quoted against nothing.
        rate: anchor === '' ? null : rateOrNull(rate),
      })
      setStatus('Saved')
      onSaved()
    } catch (err) {
      setError(errorMessage(err, 'Save failed'))
    }
  }

  if (!canEdit) {
    const stored = toStored(toDrafts(entity.denominations))
    if (stored.length === 0 && !anchorTarget) return <></>
    return (
      <Panel ariaLabel="Currency">
        <h3>Currency</h3>
        {stored.length === 0 ? null : (
          <ul className="denomination-list">
            {stored.map((d) => (
              <li key={d.name}>
                <span>{d.name}</span>
                <span className="muted">×{d.multiplier}</span>
              </li>
            ))}
          </ul>
        )}
        {anchorTarget ? (
          <p>
            1 {String(entity.name ?? '')} = {String(entity.rate ?? '?')} ×{' '}
            <Link to={`/worlds/${worldId}/currency/${anchorTarget.id}`}>
              {String(anchorTarget.name ?? anchorTarget.id)}
            </Link>
          </p>
        ) : null}
      </Panel>
    )
  }

  return (
    <Panel ariaLabel="Currency">
      <h3>Denominations</h3>
      <p className="muted">
        Sub-units of this currency, with multipliers relative to the base unit (e.g. silver = 10 ×
        copper). Single-unit currencies leave this empty.
      </p>
      {drafts.map((d, i) => (
        // Index-keyed on purpose: a row has no stable identity while it is
        // being typed, and keying on the name would remount the input on every
        // keystroke that changes it.
        <div className="denomination-row" key={i}>
          <TextField
            label={`Denomination ${i + 1} name`}
            value={d.name}
            placeholder="e.g. silver"
            onChange={(v) =>
              setDrafts((ds) => ds.map((row, j) => (j === i ? { ...row, name: v } : row)))
            }
          />
          <TextField
            label={`Denomination ${i + 1} multiplier`}
            value={d.multiplier}
            type="number"
            onChange={(v) =>
              setDrafts((ds) => ds.map((row, j) => (j === i ? { ...row, multiplier: v } : row)))
            }
          />
          <Button
            type="button"
            variant="danger"
            onClick={() => setDrafts((ds) => ds.filter((_, j) => j !== i))}
          >
            Remove {i + 1}
          </Button>
        </div>
      ))}
      <div className="form-actions">
        <Button
          type="button"
          variant="secondary"
          onClick={() => setDrafts((ds) => [...ds, { name: '', multiplier: '1' }])}
        >
          Add denomination
        </Button>
      </div>

      <h3>Exchange rate</h3>
      <SelectField
        label="Base currency"
        value={anchor}
        onChange={setAnchor}
        hint="Optional. The currency this one is quoted against — it may not be itself, and the chain may not cycle."
        options={[
          { value: '', label: '— None —' },
          ...others.map((c) => ({ value: c.id, label: String(c.name ?? c.id) })),
        ]}
      />
      {anchor === '' ? null : (
        <TextField
          label="Rate"
          value={rate}
          type="number"
          hint="This currency = rate × base currency."
          onChange={setRate}
        />
      )}

      {status ? <p role="status">{status}</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      <div className="form-actions">
        <Button type="button" onClick={() => void onSave()}>
          Save currency
        </Button>
      </div>
    </Panel>
  )
}

/** A rate input as a number, or null when blank or unparseable. */
function rateOrNull(input: string): number | null {
  const trimmed = input.trim()
  if (trimmed === '') return null
  const n = Number.parseFloat(trimmed)
  return Number.isFinite(n) ? n : null
}
