import {
  type NameIndex,
  parseBrackets,
  RELATIONSHIP_GROUP_LABELS,
  RELATIONSHIP_TYPE_ENTRIES,
  type RelationshipType,
  relationshipType,
  relationshipTypesInGroup,
  resolveBracket,
} from '@campaign-settings/shared'
import { useCallback, useMemo, useState } from 'react'
import type { EntityRelationship, WikiEntry } from '../api'
import { useApi } from '../app/api-context'
import { errorMessage } from '../app/error-message'
import { useResource } from '../app/use-resource'
import { AccordionPanel } from '../components/accordion-panel'
import { Badge } from '../components/badge'
import { Button } from '../components/button'
import { EntityRow } from '../components/entity-row'
import { SelectField, TextField } from '../components/field'
import { EmptyState } from '../components/status'

/**
 * The type picker's options, grouped. ONE list, read by the add-form and by the
 * in-place editor — two copies is how the two forms end up offering different
 * vocabularies after the next type is added.
 */
const TYPE_GROUPS = (['social', 'attributive'] as const).map((group) => ({
  label: RELATIONSHIP_GROUP_LABELS[group],
  options: relationshipTypesInGroup(group).map((e) => ({ value: e.type, label: e.label })),
}))

export interface LinkedEntity {
  kind: string
  id: string
  name: string
}

/**
 * The entities a body links to, in order of first mention.
 *
 * Deduplicated by resolved TARGET rather than by the written name, so
 * `[[Mira]]` and `[[mira]]` — which resolve to one entity — produce one card
 * instead of two. Unresolved names are omitted: they point at nothing, so there
 * is no card to navigate to. The red marker in the body itself is what reports
 * them, and duplicating that here would turn a navigation aid into a second
 * error list.
 */
export function linkedEntities(text: string, nameIndex: NameIndex): LinkedEntity[] {
  const seen = new Set<string>()
  const out: LinkedEntity[] = []
  for (const marker of parseBrackets(text)) {
    const ref = resolveBracket(marker.name, nameIndex)
    if (!ref) continue
    const key = `${ref.kind}:${ref.id}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ kind: ref.kind, id: ref.id, name: marker.name })
  }
  return out
}

/**
 * What this entity connects to, in the two ways it can.
 *
 * TYPED RELATIONSHIPS: a DM's explicit statement of HOW two entities relate,
 * each labelled with its type and rendered from whichever end is being viewed.
 * MENTIONS: what the prose happens to link to, derived from `[[brackets]]` and
 * inherently untyped.
 *
 * Both, not one. They answer different questions — "this is how they relate"
 * and "the text here refers to that" — and both can be true at once, so an
 * entity that is mentioned in the body AND typed as a member appears in each.
 * Typing a relationship deliberately does not consume the mention: that would
 * make editing prose silently mutate the relationship store.
 *
 * ## Two panels, not one panel with two subheadings
 *
 * They used to sit inside a wrapper headed "Linked entities". The wrapper named
 * a category rather than a thing, and it cost a heading level and a box for no
 * answer of its own — "Linked entities" tells a reader nothing that
 * "Relationships" and "Mentioned in this entry" do not already tell them. So
 * this component returns the two panels as siblings. It is still one component
 * because they share one `text` parse and one relationship fetch.
 *
 * Both are CLOSED accordions. They are secondary: a reader arrives for the
 * prose, and answers "what else does this touch" afterwards or not at all.
 *
 * `text` is the body being EDITED where there is an editor, not the saved one,
 * so a link becomes reachable as soon as it is written.
 */
export function LinkedEntitiesPanel({
  text,
  worldId,
  nameIndex,
  kind,
  entityId,
  candidates,
  canEdit = false,
}: {
  text: string
  worldId: string
  nameIndex: NameIndex
  kind: string
  entityId: string
  /** The entities a new relationship may point at — the authorized wiki corpus. */
  candidates: WikiEntry[]
  canEdit?: boolean
}): React.JSX.Element {
  const api = useApi()
  const mentions = useMemo(() => linkedEntities(text, nameIndex), [text, nameIndex])
  const fetcher = useCallback(
    () => api.listRelationships(worldId, kind, entityId),
    [api, worldId, kind, entityId],
  )
  const { data, reload } = useResource(fetcher)
  const relationships = data ?? []

  return (
    <>
      <AccordionPanel title="Relationships">
        {canEdit ? (
          <RelationshipForm
            worldId={worldId}
            kind={kind}
            entityId={entityId}
            candidates={candidates}
            onCreated={reload}
          />
        ) : null}
        {relationships.length === 0 ? (
          <EmptyState>
            {canEdit
              ? 'No relationships yet. Say how this connects to something above.'
              : 'No relationships recorded.'}
          </EmptyState>
        ) : (
          <ul className="entity-rows">
            {relationships.map((r) => (
              <RelationshipRow
                key={r.id}
                worldId={worldId}
                relationship={r}
                canEdit={canEdit}
                onRemoved={reload}
                onSpecified={reload}
              />
            ))}
          </ul>
        )}
      </AccordionPanel>

      <AccordionPanel title="Mentioned in this entry">
        {mentions.length === 0 ? (
          <EmptyState>Nothing linked yet. Reference another entry with [[its name]].</EmptyState>
        ) : (
          <ul className="entity-rows">
            {mentions.map((e) => (
              <EntityRow
                key={`${e.kind}:${e.id}`}
                to={`/worlds/${worldId}/${e.kind}/${e.id}`}
                name={e.name}
                kind={e.kind}
              />
            ))}
          </ul>
        )}
      </AccordionPanel>
    </>
  )
}

/**
 * One relationship, and — for a GM — the controls that change or remove it.
 *
 * ## Why "Specify" exists
 *
 * A `[[link]]` in an entity's prose now creates a relationship at "Related to".
 * A GM saying what the link actually IS must be able to do so in place. Delete
 * and re-add would lose the row's source passage, which is what governs who may
 * see it — so a bracket written inside a secret reveal would become public the
 * moment the GM described it more precisely.
 */
function RelationshipRow({
  worldId,
  relationship,
  canEdit,
  onRemoved,
  onSpecified,
}: {
  worldId: string
  relationship: EntityRelationship
  canEdit: boolean
  onRemoved: () => void
  onSpecified: () => void
}): React.JSX.Element {
  const api = useApi()
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const { other, label } = relationship

  async function onRemove(): Promise<void> {
    setError(null)
    try {
      await api.deleteRelationship(worldId, relationship.id)
      onRemoved()
    } catch (err) {
      setError(errorMessage(err, 'Remove failed'))
    }
  }

  async function onSave(type: string, qualifier: string, note: string): Promise<void> {
    setError(null)
    try {
      await api.updateRelationship(worldId, relationship.id, {
        type,
        note,
        // Only ever sent for a type that accepts one: the server refuses a
        // qualifier on a type with no vocabulary for it, and an empty string
        // means "no role" rather than a role called "".
        qualifier: relationshipType(type as RelationshipType).qualifiers
          ? qualifier === ''
            ? null
            : qualifier
          : null,
      })
      setEditing(false)
      onSpecified()
    } catch (err) {
      setError(errorMessage(err, 'Could not change the relationship'))
    }
  }

  // The SAME row as a mention, with the relationship's own marks slotted in.
  // The label leads because it is what distinguishes an asserted relationship
  // from an incidental mention; everything else trails the name.
  return (
    <EntityRow
      to={`/worlds/${worldId}/${other.kind}/${other.id}`}
      name={other.name}
      kind={other.kind}
      leading={<Badge>{label}</Badge>}
      trailing={
        <>
          {/* Its own badge, not folded into the label: a qualifier is a
              controlled value the reader can learn to scan for, which is the
              whole reason 0017 gave it a column instead of appending it to the
              note. */}
          {relationship.qualifier ? (
            <Badge className="relationship-qualifier">{relationship.qualifier}</Badge>
          ) : null}
          {relationship.note ? <span className="field-hint">{relationship.note}</span> : null}
          {canEdit ? (
            <>
              <Button
                variant="secondary"
                type="button"
                aria-expanded={editing}
                aria-label={`Specify ${label} ${other.name}`}
                onClick={() => setEditing((was) => !was)}
              >
                Specify
              </Button>
              <Button
                variant="secondary"
                type="button"
                aria-label={`Remove ${label} ${other.name}`}
                onClick={() => void onRemove()}
              >
                Remove
              </Button>
            </>
          ) : null}
          {editing ? (
            <RelationshipEditor
              relationship={relationship}
              onCancel={() => setEditing(false)}
              onSave={(type, qualifier, note) => void onSave(type, qualifier, note)}
            />
          ) : null}
          {error ? <p role="alert">{error}</p> : null}
        </>
      }
    />
  )
}

/**
 * The in-place editor behind a row's Specify button.
 *
 * Deliberately the same three controls the add-form offers, in the same order,
 * reading the same registry. A second vocabulary here is how the two forms end
 * up offering different type lists.
 */
function RelationshipEditor({
  relationship,
  onCancel,
  onSave,
}: {
  relationship: EntityRelationship
  onCancel: () => void
  onSave: (type: string, qualifier: string, note: string) => void
}): React.JSX.Element {
  const [type, setType] = useState(relationship.type)
  const [qualifier, setQualifier] = useState(relationship.qualifier ?? '')
  const [note, setNote] = useState(relationship.note)
  const qualifiers = relationshipType(type as RelationshipType).qualifiers

  return (
    <div className="relationship-form bounded-form" role="group" aria-label="Specify relationship">
      <SelectField
        label="Relationship"
        ariaLabel="New relationship type"
        value={type}
        onChange={setType}
        groups={TYPE_GROUPS}
      />
      {qualifiers ? (
        <SelectField
          label="Role"
          ariaLabel="New relationship role"
          value={qualifier}
          onChange={setQualifier}
          options={[
            { value: '', label: 'Unspecified' },
            ...qualifiers.map((q) => ({ value: q, label: q })),
          ]}
        />
      ) : null}
      <TextField
        label="Note"
        ariaLabel="New relationship note"
        value={note}
        onChange={setNote}
        placeholder="Optional"
      />
      <div className="form-actions">
        <Button type="button" onClick={() => onSave(type, qualifier, note)}>
          Save relationship
        </Button>
        <Button variant="secondary" type="button" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  )
}

/**
 * Assert a relationship from this entity.
 *
 * The target list is the wiki corpus, which the server has already filtered to
 * what this actor may see — so a relationship cannot be aimed at something
 * invisible even by accident.
 */
function RelationshipForm({
  worldId,
  kind,
  entityId,
  candidates,
  onCreated,
}: {
  worldId: string
  kind: string
  entityId: string
  candidates: WikiEntry[]
  onCreated: () => void
}): React.JSX.Element {
  const api = useApi()
  const [type, setType] = useState<string>(RELATIONSHIP_TYPE_ENTRIES[0]?.type ?? 'related_to')
  const [toId, setToId] = useState('')
  const [note, setNote] = useState('')
  const [qualifier, setQualifier] = useState('')
  const [error, setError] = useState<string | null>(null)

  // The entity itself is never a valid target; the schema refuses a self-
  // relationship, so offering it would only produce a refusal.
  const targets = candidates.filter((c) => c.id !== entityId)

  // Which qualifiers this type accepts, if any. Read from the shared registry
  // rather than branching on `type === 'speaks'`, so a second qualified type
  // needs no change here.
  const qualifiers = relationshipType(type as RelationshipType).qualifiers

  async function onSubmit(): Promise<void> {
    setError(null)
    try {
      await api.createRelationship(worldId, kind, entityId, {
        toId,
        type,
        ...(note.trim() === '' ? {} : { note: note.trim() }),
        // Only ever sent for a type that accepts one: the server refuses a
        // qualifier on a type with no vocabulary for it, so sending a stale value
        // after the picker changed would turn a valid submission into a 400.
        ...(qualifiers && qualifier !== '' ? { qualifier } : {}),
      })
      setToId('')
      setNote('')
      setQualifier('')
      onCreated()
    } catch (err) {
      setError(errorMessage(err, 'Could not add the relationship'))
    }
  }

  return (
    <div className="relationship-form bounded-form">
      <SelectField
        label="Relationship"
        // Explicit, because a wrapping <label> takes its text content from
        // everything inside it — including every option of the select, which
        // would make the field's accessible name the whole vocabulary.
        ariaLabel="Relationship"
        value={type}
        onChange={setType}
        // Grouped, not flat: 0017 took this list from eleven types to fifteen, and
        // "Ally of" beside "Speaks" in one run of options asks the reader to notice
        // a distinction the list does not draw.
        groups={TYPE_GROUPS}
      />
      <SelectField
        label="To"
        ariaLabel="Relationship target"
        value={toId}
        onChange={setToId}
        options={[
          { value: '', label: 'Choose an entry…' },
          ...targets.map((c) => ({ value: c.id, label: c.name })),
        ]}
      />
      {qualifiers ? (
        <SelectField
          label="Role"
          ariaLabel="Relationship role"
          value={qualifier}
          onChange={setQualifier}
          // Optional on purpose: recording that an NPC speaks a language without
          // saying in what capacity records something true.
          options={[
            { value: '', label: 'Unspecified' },
            ...qualifiers.map((q) => ({ value: q, label: q })),
          ]}
        />
      ) : null}
      <TextField label="Note" value={note} onChange={setNote} placeholder="Optional" />
      <Button type="button" disabled={toId === ''} onClick={() => void onSubmit()}>
        Add relationship
      </Button>
      {error ? <p role="alert">{error}</p> : null}
    </div>
  )
}
