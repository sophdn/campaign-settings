import { type FieldDef, fieldsForKindName } from '@campaign-settings/shared'
import { Fragment, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import type { Entity, MemberView, WikiEntry } from '../api'
import { CheckboxField, SelectField, TextField } from './field'
import { TextAreaField } from './text-area-field'
import { hasValue, optionLabel } from './typed-field-values'

/**
 * The per-kind typed fields, rendered from the shared registry — one editor and
 * one read view for all 16 content kinds, instead of dm-manager's branch per
 * kind in the form plus a matching branch in the display.
 *
 * `[[mention]]`-bearing prose is NOT here. The description stays the editor's
 * own field with its bracket picker and live preview; these are the scalar
 * columns beside it.
 */

/** The entities an `entityRef` field may point at, by kind. */
export type RefCandidates = ReadonlyArray<WikiEntry>

/**
 * The accounts an `accountRef` field may point at: this world's members.
 *
 * `null` means "not loaded yet" and is distinct from an empty list, which means
 * a world with no players in it. The picker says something different for each,
 * because "still loading" and "invite someone first" are different situations
 * and a spinner-shaped empty state is how a GM concludes the feature is broken.
 */
export type AccountCandidates = ReadonlyArray<MemberView> | null

/**
 * Options for an account picker. The world's members, minus the owner — the GM
 * is not a player of one of the characters, and offering themselves is a choice
 * that means nothing.
 */
function accountOptions(
  members: AccountCandidates,
): ReadonlyArray<{ value: string; label: string }> {
  if (members === null) return [{ value: '', label: 'Loading players…' }]
  const players = members.filter((m) => m.role !== 'owner')
  if (players.length === 0) {
    return [{ value: '', label: 'No players in this world yet' }]
  }
  return [
    { value: '', label: '— Nobody —' },
    ...players
      .map((m) => ({ value: m.accountId, label: m.username }))
      .sort((a, b) => a.label.localeCompare(b.label)),
  ]
}

/** Options for a ref picker: the visible entities of that kind, plus "None". */
function refOptions(
  field: FieldDef,
  candidates: RefCandidates,
): ReadonlyArray<{ value: string; label: string }> {
  const of = candidates
    .filter((c) => c.kind === field.refKind)
    .map((c) => ({ value: c.id, label: c.name }))
    .sort((a, b) => a.label.localeCompare(b.label))
  return [{ value: '', label: '— None —' }, ...of]
}

/**
 * One editable control per registry field.
 *
 * The ref picker is built from the wiki candidates the page has already
 * fetched, which the server filtered to what this viewer may see — so the
 * picker cannot offer a species the owner has hidden from themselves, and no
 * extra request is made per ref field.
 */
export function TypedFieldInputs({
  fields,
  values,
  onChange,
  candidates,
  members = null,
}: {
  fields: readonly FieldDef[]
  values: Record<string, string>
  onChange: (key: string, value: string) => void
  candidates: RefCandidates
  /** Only consulted by `accountRef` fields; today that is pc's "Played by". */
  members?: AccountCandidates
}): React.JSX.Element | null {
  if (fields.length === 0) return null
  return (
    <>
      {fields.map((f) => {
        const value = values[f.key] ?? ''
        const hint = f.hint === undefined ? {} : { hint: f.hint }
        const placeholder = f.placeholder === undefined ? {} : { placeholder: f.placeholder }

        if (f.type === 'boolean') {
          return (
            <CheckboxField
              key={f.key}
              label={f.label}
              checked={value === 'true'}
              onChange={(checked) => onChange(f.key, checked ? 'true' : 'false')}
              {...hint}
            />
          )
        }
        if (f.type === 'textarea') {
          return (
            <TextAreaField
              key={f.key}
              label={f.label}
              value={value}
              onChange={(v) => onChange(f.key, v)}
              rows={3}
              {...hint}
              {...placeholder}
            />
          )
        }
        if (f.type === 'accountRef') {
          return (
            <SelectField
              key={f.key}
              label={f.label}
              value={value}
              onChange={(v) => onChange(f.key, v)}
              options={accountOptions(members)}
              {...hint}
            />
          )
        }
        if (f.type === 'enum' || f.type === 'entityRef') {
          // An enum offers a closed taxonomy plus a blank, so a settlement whose
          // size was never set does not silently acquire the first one on save.
          const options =
            f.type === 'entityRef'
              ? refOptions(f, candidates)
              : [
                  { value: '', label: '— None —' },
                  ...(f.options ?? []).map((o) => ({ value: o.value, label: o.label })),
                ]
          return (
            <SelectField
              key={f.key}
              label={f.label}
              value={value}
              onChange={(v) => onChange(f.key, v)}
              options={options}
              {...hint}
            />
          )
        }
        return (
          <TextField
            key={f.key}
            label={f.label}
            value={value}
            onChange={(v) => onChange(f.key, v)}
            {...(f.type === 'number' ? { type: 'number' } : {})}
            {...hint}
            {...placeholder}
          />
        )
      })}
    </>
  )
}

/**
 * One field's displayed value, or null when the row should not appear at all.
 *
 * A plain function rather than a component ON PURPOSE: the caller has to know
 * whether there is a value BEFORE it emits the `<dt>`, and a component's `null`
 * only happens at render time — which is how an earlier draft printed a label
 * over an empty cell for a ref the viewer could not resolve.
 */
function readValue(
  field: FieldDef,
  entity: Entity,
  worldId: string,
  candidates: RefCandidates,
  members: AccountCandidates,
): ReactNode | null {
  const raw = entity[field.key]

  if (field.type === 'boolean') {
    // A boolean is never "unset" — false is an answer — so it always lists.
    return raw ? 'Yes' : 'No'
  }
  if (!hasValue(field, entity)) return null

  if (field.type === 'entityRef') {
    const target = candidates.find((c) => c.id === String(raw))
    // Unresolvable means the referenced entity is soft-deleted or restricted
    // from this viewer. Drop the row WHOLE rather than print a bare id — the
    // same rule map pins and typed relationships already follow, because the
    // name is exactly what the visibility filter is protecting.
    if (!target) return null
    return <Link to={`/worlds/${worldId}/${target.kind}/${target.id}`}>{target.name}</Link>
  }
  if (field.type === 'accountRef') {
    // A username, never the id — and nothing at all when the member list has
    // not arrived or the account is no longer in this world. Printing the raw
    // id would be worse than printing nothing: it is unreadable AND it is the
    // one part of an account a page has no business displaying.
    const member = members?.find((m) => m.accountId === String(raw))
    return member ? member.username : null
  }
  if (field.type === 'enum') return optionLabel(field, String(raw))
  return String(raw)
}

/**
 * The typed fields of an entity as a definition list. Rendered for owners and
 * players alike: these are columns of the entity itself, so anyone entitled to
 * see the entity is entitled to see them. The owner-only material is
 * `imported_metadata` below, and the per-entity `visibility` control elsewhere.
 */
export function TypedFieldList({
  kind,
  entity,
  worldId,
  candidates,
  members = null,
}: {
  kind: string
  entity: Entity
  worldId: string
  candidates: RefCandidates
  /** Only consulted by `accountRef` fields; today that is pc's "Played by". */
  members?: AccountCandidates
}): React.JSX.Element | null {
  const rows = fieldsForKindName(kind)
    .map((field) => ({ field, node: readValue(field, entity, worldId, candidates, members) }))
    .filter((r): r is { field: FieldDef; node: ReactNode } => r.node !== null)

  if (rows.length === 0) return null
  return (
    <dl className="typed-fields" aria-label="Details">
      {rows.map(({ field, node }) => (
        <Fragment key={field.key}>
          <dt>{field.label}</dt>
          <dd>{node}</dd>
        </Fragment>
      ))}
    </dl>
  )
}

/**
 * The provenance blob an import left on the entity, collapsed.
 *
 * Owner-only, deliberately. It is whatever the source system happened to carry
 * — ids, timestamps, fields this app never modelled — and it is the one thing
 * on the page that can hold detail the owner curated OUT of the visible entity.
 * Showing it to players would route around every visibility decision they made.
 */
export function ImportedMetadata({ entity }: { entity: Entity }): React.JSX.Element | null {
  const raw = entity.imported_metadata
  if (raw === null || raw === undefined) return null
  if (typeof raw === 'object' && Object.keys(raw as object).length === 0) return null
  return (
    <details className="imported-metadata">
      <summary>Imported metadata</summary>
      <pre>{JSON.stringify(raw, null, 2)}</pre>
    </details>
  )
}
