import { useCallback, useState } from 'react'
import { Link } from 'react-router-dom'
import type { CurrencyAttachment, CurrencyOwnerKind } from '../api'
import { useApi } from '../app/api-context'
import { errorMessage } from '../app/error-message'
import { useResource } from '../app/use-resource'
import { Badge } from '../components/badge'
import { Button } from '../components/button'
import { SelectField, TextField } from '../components/field'
import { Panel } from '../components/panel'
import { EmptyState, ErrorText, Loading } from '../components/status'
import { VISIBILITY_LABELS } from './visibility-panel'

/**
 * The currencies a settlement or an organization uses.
 *
 * ## ONE component, parameterized by owner kind
 *
 * A settlement's currencies and an organization's are the same feature over a
 * different owner column — the same shape migration 0017 and chain 398 task 4
 * both chose over per-kind duplication, and the same shape the server takes
 * (`data/currency-attachments.ts` is written once against a per-kind spec). Two
 * near-identical panels would be two places for the visibility copy, the primary
 * semantics and the empty state to drift.
 *
 * ## Per-row visibility IS exposed, and why
 *
 * These rows carry their own `visibility`, unlike a typed relationship, and that
 * is the whole reason chain 398 refused to fold them into `entity_relationships`.
 * Exposing it lets a GM hide "this settlement secretly uses the enemy's coin"
 * while the settlement itself stays public — a thing the model can express and,
 * before this panel, nothing could reach.
 *
 * The control is a plain select rather than the shared `VisibilityControl`,
 * because that component's second half is a per-player GRANT list and an
 * attachment cannot have one: `restricted` needs an ACL foreign-keyed to the row
 * being granted, and no table is. So the reuse is the LABELS — imported from
 * `visibility-panel.tsx`, the one place they are written — and the level list is
 * the two an attachment can actually hold. The server refuses `restricted`
 * outright rather than storing a level that behaves as `dm_only`.
 *
 * ## What a player sees
 *
 * The rows the two server-side rules allow, and no control at all. The read is
 * already filtered before it arrives — a row naming a hidden currency is dropped
 * whole rather than sent nameless — so nothing here filters, and the absence of
 * the controls is a courtesy: every write behind them is owner-gated in
 * `authz/content.ts`, and the HTTP tests assert a player's attempt draws a 403.
 */

/** The levels an attachment can hold — `restricted` is not one. See above. */
const LEVELS = ['public', 'dm_only'] as const
const LEVEL_OPTIONS = LEVELS.map((v) => ({ value: v, label: VISIBILITY_LABELS[v] }))

export function CurrencyAttachmentsPanel({
  worldId,
  ownerKind,
  ownerId,
  canEdit,
}: {
  worldId: string
  ownerKind: CurrencyOwnerKind
  ownerId: string
  canEdit: boolean
}): React.JSX.Element {
  const api = useApi()
  // Keyed on the KIND as well as the id: reclassifying a settlement into an
  // organization keeps the id and changes which table its attachments live in,
  // and `change-kind.ts` clears the old ones. Without the kind in here the panel
  // would keep showing the rows the reclassify just cleared.
  const fetcher = useCallback(
    () => api.listCurrencyAttachments(worldId, ownerKind, ownerId),
    [api, worldId, ownerKind, ownerId],
  )
  const { data, loading, error, reload } = useResource(fetcher)
  // Defaulted ONCE. `data` is null while loading and after a failed read, and
  // spreading `?? []` across every use below would be four places for that to be
  // spelled and three of them unreachable.
  const rows = data ?? []

  return (
    <Panel ariaLabel="Currencies">
      <h3>Currencies</h3>
      <p className="field-hint">
        The coin that changes hands here. Mark one as primary to say which this place actually
        reckons in.
      </p>
      <ErrorText>{error}</ErrorText>

      {loading ? (
        <Loading />
      ) : (
        <>
          {rows.length === 0 ? (
            <EmptyState>
              {canEdit
                ? 'No currencies attached yet.'
                : 'No currencies are recorded for this entry.'}
            </EmptyState>
          ) : (
            <ul className="currency-attachment-list">
              {rows.map((attachment) => (
                <AttachmentRow
                  // Keyed by the ROW's id, which is what identifies it in a list.
                  // This is not the keying bug 1221 was about: that was a `key` on
                  // the PANEL at its render site in `entity-detail-page.tsx`, which
                  // left inert duplicate panels on the built SPA. See the comment
                  // at this panel's mount point.
                  key={attachment.id}
                  worldId={worldId}
                  ownerKind={ownerKind}
                  attachment={attachment}
                  canEdit={canEdit}
                  onChanged={reload}
                />
              ))}
            </ul>
          )}
          {canEdit ? (
            <AttachForm
              worldId={worldId}
              ownerKind={ownerKind}
              ownerId={ownerId}
              attached={rows}
              onAttached={reload}
            />
          ) : null}
        </>
      )}
    </Panel>
  )
}

function AttachmentRow({
  worldId,
  ownerKind,
  attachment,
  canEdit,
  onChanged,
}: {
  worldId: string
  ownerKind: CurrencyOwnerKind
  attachment: CurrencyAttachment
  canEdit: boolean
  onChanged: () => void
}): React.JSX.Element {
  const api = useApi()
  const [notes, setNotes] = useState(attachment.notes)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const name = attachment.currency.name

  async function run(fn: () => Promise<unknown>, fallback: string): Promise<void> {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await fn()
      // No transient "Saved" line: every write here reloads the list, which
      // remounts this row, so a status message would be racing its own unmount —
      // and an e2e assertion on one would be a flake (bug 1221's second lesson).
      // What changed is visible in the list itself.
      onChanged()
    } catch (err) {
      setError(errorMessage(err, fallback))
    } finally {
      setBusy(false)
    }
  }

  return (
    <li className="currency-attachment-row">
      <div className="currency-attachment-head">
        <Link to={`/worlds/${worldId}/currency/${attachment.currency.id}`}>{name}</Link>
        {attachment.isPrimary ? <Badge>Primary</Badge> : null}
        {canEdit && !attachment.isPrimary ? (
          <Button
            type="button"
            variant="secondary"
            disabled={busy}
            aria-label={`Make ${name} primary`}
            onClick={() =>
              void run(
                () =>
                  api.updateCurrencyAttachment(worldId, ownerKind, attachment.id, {
                    isPrimary: true,
                  }),
                `Could not make ${name} primary`,
              )
            }
          >
            Make primary
          </Button>
        ) : null}
        {canEdit ? (
          <Button
            type="button"
            variant="danger"
            disabled={busy}
            aria-label={`Detach ${name}`}
            onClick={() =>
              void run(
                () => api.detachCurrency(worldId, ownerKind, attachment.id),
                `Could not detach ${name}`,
              )
            }
          >
            Detach
          </Button>
        ) : null}
      </div>

      {canEdit ? (
        <>
          <TextField
            label="Notes"
            ariaLabel={`Notes for ${name}`}
            value={notes}
            onChange={setNotes}
            disabled={busy}
          />
          {notes === attachment.notes ? null : (
            <Button
              type="button"
              variant="secondary"
              disabled={busy}
              aria-label={`Save notes for ${name}`}
              onClick={() =>
                void run(
                  () => api.updateCurrencyAttachment(worldId, ownerKind, attachment.id, { notes }),
                  'Could not save those notes',
                )
              }
            >
              Save notes
            </Button>
          )}
          <SelectField
            label="Visibility"
            ariaLabel={`${name} visibility`}
            value={attachment.visibility}
            options={LEVEL_OPTIONS}
            onChange={(next) =>
              void run(
                () =>
                  api.updateCurrencyAttachment(worldId, ownerKind, attachment.id, {
                    visibility: next as (typeof LEVELS)[number],
                  }),
                'Could not change who can see this',
              )
            }
          />
        </>
      ) : (
        attachment.notes !== '' && <p className="muted">{attachment.notes}</p>
      )}
      <ErrorText>{error}</ErrorText>
    </li>
  )
}

/**
 * The attach control: pick a currency, optionally say something about it.
 *
 * Currencies already attached are excluded from the list rather than left in it
 * to draw a 409. The server still refuses the duplicate — a stale list, or two
 * tabs, can still get there — but offering a choice that is guaranteed to fail is
 * not a check, it is a trap.
 */
function AttachForm({
  worldId,
  ownerKind,
  ownerId,
  attached,
  onAttached,
}: {
  worldId: string
  ownerKind: CurrencyOwnerKind
  ownerId: string
  attached: readonly CurrencyAttachment[]
  onAttached: () => void
}): React.JSX.Element {
  const api = useApi()
  const listCurrencies = useCallback(() => api.listEntities(worldId, 'currency'), [api, worldId])
  const { data: currencies } = useResource(listCurrencies)

  const [choice, setChoice] = useState('')
  const [notes, setNotes] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  /*
    RE-SEED WHEN THE PAGE MOVES TO ANOTHER OWNER, rather than with a `key` on the
    render site. The same reasoning as `currency-panel.tsx`: keying this panel at
    its mount point is exactly what produced bug 1221's inert duplicate panels on
    the built SPA. Adjusting state during render is React's documented answer to
    "reset state when a prop changes" — it runs before children render, and only
    when the OWNER IDENTITY changes, so a plain refetch of the same owner does not
    discard a half-typed note.
  */
  const [seededFor, setSeededFor] = useState(ownerId)
  if (seededFor !== ownerId) {
    setSeededFor(ownerId)
    setChoice('')
    setNotes('')
    setError(null)
  }

  const taken = new Set(attached.map((a) => a.currency.id))
  const available = (currencies ?? []).filter((c) => !taken.has(c.id))

  if (available.length === 0) {
    return (
      <p className="field-hint">
        {(currencies ?? []).length === 0
          ? 'This world has no currencies yet. Create one to attach it here.'
          : 'Every currency in this world is already attached here.'}
      </p>
    )
  }

  async function onAttach(): Promise<void> {
    if (choice === '' || busy) return
    setBusy(true)
    setError(null)
    try {
      await api.attachCurrency(worldId, ownerKind, ownerId, {
        currencyId: choice,
        ...(notes.trim() === '' ? {} : { notes: notes.trim() }),
      })
      setChoice('')
      setNotes('')
      onAttached()
    } catch (err) {
      setError(errorMessage(err, 'Could not attach that currency'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="currency-attach-form">
      <SelectField
        label="Attach a currency"
        ariaLabel="Attach a currency"
        value={choice}
        onChange={setChoice}
        options={[
          { value: '', label: 'Choose one…' },
          ...available.map((c) => ({ value: c.id, label: String(c.name ?? c.id) })),
        ]}
      />
      <TextField
        label="Notes"
        ariaLabel="Notes for the new attachment"
        value={notes}
        onChange={setNotes}
        disabled={busy}
      />
      <Button type="button" disabled={busy || choice === ''} onClick={() => void onAttach()}>
        Attach
      </Button>
      <ErrorText>{error}</ErrorText>
    </div>
  )
}
