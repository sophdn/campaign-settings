import {
  type NameIndex,
  parseBrackets,
  RELATIONSHIP_TYPE_ENTRIES,
  resolveBracket,
} from '@campaign-settings/shared'
import { useCallback, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import type { EntityRelationship, WikiEntry } from '../api'
import { useApi } from '../app/api-context'
import { errorMessage } from '../app/error-message'
import { useResource } from '../app/use-resource'
import { Badge } from '../components/badge'
import { Button } from '../components/button'
import { CardLink } from '../components/card-link'
import { SelectField, TextField } from '../components/field'
import { Panel } from '../components/panel'
import { EmptyState } from '../components/status'
import { kindColor, kindLabel } from './kind-color'

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
 * TYPED RELATIONSHIPS come first: a DM's explicit statement of HOW two entities
 * relate, each labelled with its type and rendered from whichever end is being
 * viewed. MENTIONS follow: what the prose happens to link to, derived from
 * `[[brackets]]` and inherently untyped.
 *
 * Both groups, not one. They answer different questions — "this is how they
 * relate" and "the text here refers to that" — and both can be true at once, so
 * an entity that is mentioned in the body AND typed as a member appears in each.
 * Typing a relationship deliberately does not consume the mention: that would
 * make editing prose silently mutate the relationship store.
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
    <Panel ariaLabel="Linked entities">
      <h3>Linked entities</h3>

      {/* Two groups, each addressable in its own right — so a reader (and a
          screen reader) can tell an asserted relationship from an incidental
          mention without inferring it from position. */}
      <section aria-label="Relationships">
        <h4>Relationships</h4>
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
          <ul className="relationship-list">
            {relationships.map((r) => (
              <RelationshipRow
                key={r.id}
                worldId={worldId}
                relationship={r}
                canEdit={canEdit}
                onRemoved={reload}
              />
            ))}
          </ul>
        )}
      </section>

      <section aria-label="Mentioned in this entry">
        <h4>Mentioned in this entry</h4>
        {mentions.length === 0 ? (
          <EmptyState>Nothing linked yet. Reference another entry with [[its name]].</EmptyState>
        ) : (
          <ul className="card-grid">
            {mentions.map((e) => (
              <CardLink
                key={`${e.kind}:${e.id}`}
                to={`/worlds/${worldId}/${e.kind}/${e.id}`}
                title={e.name}
                meta={
                  <Badge className="wiki-kind" color={kindColor(e.kind)}>
                    {kindLabel(e.kind)}
                  </Badge>
                }
              />
            ))}
          </ul>
        )}
      </section>
    </Panel>
  )
}

function RelationshipRow({
  worldId,
  relationship,
  canEdit,
  onRemoved,
}: {
  worldId: string
  relationship: EntityRelationship
  canEdit: boolean
  onRemoved: () => void
}): React.JSX.Element {
  const api = useApi()
  const [error, setError] = useState<string | null>(null)
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

  return (
    <li className="relationship-row">
      {/* The label is what distinguishes this from a bare mention, so it leads. */}
      <Badge>{label}</Badge>
      <Link to={`/worlds/${worldId}/${other.kind}/${other.id}`}>{other.name}</Link>
      <Badge className="wiki-kind" color={kindColor(other.kind)}>
        {kindLabel(other.kind)}
      </Badge>
      {relationship.note ? <span className="field-hint">{relationship.note}</span> : null}
      {canEdit ? (
        <Button
          variant="secondary"
          type="button"
          aria-label={`Remove ${label} ${other.name}`}
          onClick={() => void onRemove()}
        >
          Remove
        </Button>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
    </li>
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
  const [error, setError] = useState<string | null>(null)

  // The entity itself is never a valid target; the schema refuses a self-
  // relationship, so offering it would only produce a refusal.
  const targets = candidates.filter((c) => c.id !== entityId)

  async function onSubmit(): Promise<void> {
    setError(null)
    try {
      await api.createRelationship(worldId, kind, entityId, {
        toId,
        type,
        ...(note.trim() === '' ? {} : { note: note.trim() }),
      })
      setToId('')
      setNote('')
      onCreated()
    } catch (err) {
      setError(errorMessage(err, 'Could not add the relationship'))
    }
  }

  return (
    <div className="relationship-form">
      <SelectField
        label="Relationship"
        // Explicit, because a wrapping <label> takes its text content from
        // everything inside it — including every option of the select, which
        // would make the field's accessible name the whole vocabulary.
        ariaLabel="Relationship"
        value={type}
        onChange={setType}
        options={RELATIONSHIP_TYPE_ENTRIES.map((e) => ({ value: e.type, label: e.label }))}
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
      <TextField label="Note" value={note} onChange={setNote} placeholder="Optional" />
      <Button type="button" disabled={toId === ''} onClick={() => void onSubmit()}>
        Add relationship
      </Button>
      {error ? <p role="alert">{error}</p> : null}
    </div>
  )
}
