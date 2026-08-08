import { contentKinds, type NameIndex, type Visibility } from '@campaign-settings/shared'
import { Fragment, useCallback, useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import type { ApiClient, Entity, WikiEntry } from '../api'
import { useApi } from '../app/api-context'
import { errorMessage } from '../app/error-message'
import { useWikiIndex } from '../app/use-name-index'
import { useResource } from '../app/use-resource'
import { useWorld } from '../app/world-context'
import { BackLink } from '../components/back-link'
import { Button } from '../components/button'
import { EntityDescription } from '../components/entity-description'
import { SelectField, TextField } from '../components/field'
import { FormCard } from '../components/form-card'
import { Panel } from '../components/panel'
import { ErrorText, Loading } from '../components/status'
import { TextAreaField } from '../components/text-area-field'
import { EntityMediaPanel } from './entity-media-panel'
import { EntitySessions } from './entity-sessions'
import { EntityPassagesPanel } from './entity-passages-panel'
import { ProposePassagePanel } from './propose-passage-panel'
import { EntityVisibilityPanel } from './entity-visibility-panel'
import { LinkedEntitiesPanel } from './linked-entities-panel'
import { EntityMaps } from './maps-page'
import { SessionTouches } from './session-touches'

/** One editable field: its payload/state key, label, and how to read it off the entity. */
interface EditorField {
  key: string
  label: string
  multiline?: boolean
  placeholder?: string
  initial: (entity: Entity) => string
  /** When set, a live [[...]] preview of this field renders under it. */
  previewLabel?: string
}

// A plain entity edits name + description (the fields every kind shares); a
// session is bespoke — a played_at date and a captured_text recap where
// [[mentions]] become graph bracket-edges. Same editor, different field lists.
const ENTITY_FIELDS: EditorField[] = [
  { key: 'name', label: 'Name', initial: (e) => String(e.name ?? '') },
  {
    key: 'description',
    label: 'Description',
    multiline: true,
    initial: (e) => String(e.description ?? ''),
    previewLabel: 'Description preview',
  },
]
const SESSION_FIELDS: EditorField[] = [
  { key: 'name', label: 'Name', initial: (e) => String(e.name ?? '') },
  {
    key: 'played_at',
    label: 'Played at',
    placeholder: 'e.g. 2026-06-27',
    initial: (e) => String(e.played_at ?? ''),
  },
  {
    key: 'captured_text',
    label: 'Summary',
    multiline: true,
    initial: (e) => String(e.captured_text ?? ''),
    previewLabel: 'Recap preview',
  },
]

interface EditorProps {
  api: ApiClient
  worldId: string
  kind: string
  entity: Entity
  nameIndex: NameIndex
  /** Entities the `[[name]]` picker may offer while editing. */
  candidates: WikiEntry[]
  /**
   * Reports the bracket-bearing field's current text upward, so the linked-
   * entities panel — which sits OUTSIDE this form, between Type and Who can see
   * this — reflects the body being edited rather than the last saved one.
   */
  onBodyChange?: (text: string) => void
  onDeleted: () => void
}

/** A labelled live render of the `[[...]]`-bearing body being edited. */
function BodyPreview({
  label,
  text,
  worldId,
  nameIndex,
}: {
  label: string
  text: string
  worldId: string
  nameIndex: NameIndex
}): React.JSX.Element | null {
  if (!text.trim()) return null
  return (
    <section className="description-preview" aria-label={label}>
      <span className="preview-label">Preview</span>
      <EntityDescription text={text} worldId={worldId} nameIndex={nameIndex} />
    </section>
  )
}

/**
 * Edit/delete a loaded entity. Driven by a `fields` descriptor, so a plain
 * entity and a session share one form and one save/delete path — only the field
 * list and the update payload's keys differ.
 */
function EntityEditor({
  api,
  worldId,
  kind,
  entity,
  nameIndex,
  candidates,
  onBodyChange,
  onDeleted,
  fields,
  ariaLabel,
}: EditorProps & { fields: EditorField[]; ariaLabel: string }): React.JSX.Element {
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(fields.map((f) => [f.key, f.initial(entity)])),
  )
  const [status, setStatus] = useState<string | null>(null)
  const set = (key: string, value: string): void => {
    setValues((prev) => ({ ...prev, [key]: value }))
    // `previewLabel` marks the bracket-bearing field — the one whose links the
    // panel lists — so the same marker drives the picker, the preview and this.
    if (fields.find((f) => f.key === key)?.previewLabel !== undefined) onBodyChange?.(value)
  }

  async function onSave(): Promise<void> {
    setStatus(null)
    try {
      const payload = Object.fromEntries(fields.map((f) => [f.key, values[f.key] ?? '']))
      await api.updateEntity(worldId, kind, entity.id, payload)
      setStatus('Saved')
    } catch (err) {
      setStatus(errorMessage(err, 'Save failed'))
    }
  }

  async function onDelete(): Promise<void> {
    try {
      await api.deleteEntity(worldId, kind, entity.id)
      onDeleted()
    } catch (err) {
      setStatus(errorMessage(err, 'Delete failed'))
    }
  }

  return (
    <FormCard ariaLabel={ariaLabel} onSubmit={onSave}>
      {fields.map((f) => (
        <Fragment key={f.key}>
          {f.multiline ? (
            <TextAreaField
              label={f.label}
              value={values[f.key] ?? ''}
              onChange={(v) => set(f.key, v)}
              // `previewLabel` marks the bracket-bearing fields — the same ones
              // that get a live [[...]] render — so the picker and the preview
              // can never disagree about which fields carry references.
              {...(f.previewLabel === undefined
                ? {}
                : {
                    candidates,
                    hint: 'Type [[ to link another entry. Matches on its name; capitalisation does not matter.',
                  })}
            />
          ) : (
            <TextField
              label={f.label}
              value={values[f.key] ?? ''}
              onChange={(v) => set(f.key, v)}
              {...(f.placeholder === undefined ? {} : { placeholder: f.placeholder })}
            />
          )}
          {f.previewLabel === undefined ? null : (
            <BodyPreview
              label={f.previewLabel}
              text={values[f.key] ?? ''}
              worldId={worldId}
              nameIndex={nameIndex}
            />
          )}
        </Fragment>
      ))}
      {status ? <p role="status">{status}</p> : null}
      <div className="form-actions">
        <Button type="submit">Save</Button>
        <Button variant="danger" type="button" onClick={() => void onDelete()}>
          Delete
        </Button>
      </div>
    </FormCard>
  )
}

/**
 * Owner-only "change type" control: reclassify the entity to another content
 * kind. Type-specific fields are cleared server-side; on success we route to the
 * entity's URL under its new kind.
 */
function KindChanger({
  api,
  worldId,
  kind,
  id,
}: {
  api: ApiClient
  worldId: string
  kind: string
  id: string
}): React.JSX.Element {
  const navigate = useNavigate()
  // The select reflects the entity's CURRENT kind (all content kinds are
  // offered); reclassifying only happens once a different one is picked.
  const options = contentKinds().map((k) => ({ value: k.kind as string, label: k.label.singular }))
  const [toKind, setToKind] = useState<string>(kind)
  const [status, setStatus] = useState<string | null>(null)

  async function onChange(): Promise<void> {
    if (toKind === kind) return
    setStatus(null)
    try {
      await api.changeEntityKind(worldId, kind, id, toKind)
      await navigate(`/worlds/${worldId}/${toKind}/${id}`)
    } catch (err) {
      setStatus(errorMessage(err, 'Change failed'))
    }
  }

  return (
    <Panel>
      <h3>Type</h3>
      <p className="muted">
        Reclassify this entity. Type-specific fields are cleared when the type changes.
      </p>
      <div className="form-actions">
        <SelectField
          label="Type"
          ariaLabel="Type"
          value={toKind}
          onChange={setToKind}
          options={options}
        />
        <Button type="button" onClick={() => void onChange()} disabled={toKind === kind}>
          Change type
        </Button>
      </div>
      {status ? <p role="status">{status}</p> : null}
    </Panel>
  )
}

/** Read-only entity/session view for players (writes are owner-only, server-gated). */
function ReadOnlyView({
  entity,
  worldId,
  nameIndex,
  body,
  date,
}: {
  entity: Entity
  worldId: string
  nameIndex: NameIndex
  body: string
  date?: string
}): React.JSX.Element {
  return (
    <Panel>
      <h2>{String(entity.name ?? entity.id)}</h2>
      {date ? <p>{date}</p> : null}
      <EntityDescription text={body} worldId={worldId} nameIndex={nameIndex} />
    </Panel>
  )
}

export function EntityDetailPage(): React.JSX.Element {
  const api = useApi()
  const navigate = useNavigate()
  const { role } = useWorld()
  const { worldId = '', kind = '', id = '' } = useParams()
  const fetcher = useCallback(() => api.getEntity(worldId, kind, id), [api, worldId, kind, id])
  const { data: entity, loading, error, reload } = useResource(fetcher)
  const { nameIndex, candidates } = useWikiIndex(worldId)
  // The body currently in the editor; null until it is touched, so a reader with
  // no editor still gets the saved text. Cleared when the page moves to another
  // entity, which happens without a remount.
  const [editedBody, setEditedBody] = useState<string | null>(null)
  const entityId = entity?.id
  useEffect(() => setEditedBody(null), [entityId])

  if (loading) return <Loading />
  if (error || !entity) return <ErrorText>{error ?? 'Not found'}</ErrorText>
  const onDeleted = (): void => {
    void navigate('..', { relative: 'path' })
  }

  // Every content row carries a visibility level; a row that somehow lacks one
  // is treated as `public`, matching the column's own default.
  const visibility = (entity.visibility as Visibility | undefined) ?? 'public'
  // Reveals sit with the visibility control: both answer "who sees what here".
  // Sessions and maps cannot own passages (entity_passages.entity_id is FK'd to
  // `entities`), so the panel is not offered for them.
  const passagesPanel =
    role === 'owner' && kind !== 'session' ? (
      <EntityPassagesPanel
        key={`passages-${entity.id}`}
        api={api}
        worldId={worldId}
        kind={kind}
        entityId={entity.id}
        onChanged={reload}
      />
    ) : null
  // A player's one write. Not offered on sessions, which cannot own passages.
  const proposePanel =
    role !== 'owner' && kind !== 'session' ? (
      <ProposePassagePanel
        key={`propose-${entity.id}`}
        api={api}
        worldId={worldId}
        kind={kind}
        entityId={entity.id}
        candidates={candidates}
        onProposed={reload}
      />
    ) : null
  const visibilityPanel =
    role === 'owner' ? (
      <EntityVisibilityPanel
        key={entity.id}
        api={api}
        worldId={worldId}
        kind={kind}
        entityId={entity.id}
        initialVisibility={visibility}
      />
    ) : null

  if (kind === 'session') {
    return (
      <>
        <BackLink to={`/worlds/${worldId}`}>Back to wiki</BackLink>
        {role === 'owner' ? (
          <EntityEditor
            key={entity.id}
            api={api}
            worldId={worldId}
            kind="session"
            entity={entity}
            nameIndex={nameIndex}
            candidates={candidates}
            onBodyChange={setEditedBody}
            onDeleted={onDeleted}
            fields={SESSION_FIELDS}
            ariaLabel="Edit session"
          />
        ) : (
          <ReadOnlyView
            entity={entity}
            worldId={worldId}
            nameIndex={nameIndex}
            body={String(entity.captured_text ?? '')}
            date={String(entity.played_at ?? '')}
          />
        )}
        <LinkedEntitiesPanel
          text={editedBody ?? String(entity.captured_text ?? '')}
          worldId={worldId}
          nameIndex={nameIndex}
          kind="session"
          entityId={entity.id}
          candidates={candidates}
          canEdit={role === 'owner'}
        />
        {visibilityPanel}
        <SessionTouches sessionId={entity.id} role={role} />
      </>
    )
  }
  return (
    <>
      <BackLink to={`/worlds/${worldId}`}>Back to wiki</BackLink>
      {role === 'owner' ? (
        <>
          <EntityEditor
            key={entity.id}
            api={api}
            worldId={worldId}
            kind={kind}
            entity={entity}
            nameIndex={nameIndex}
            candidates={candidates}
            onBodyChange={setEditedBody}
            onDeleted={onDeleted}
            fields={ENTITY_FIELDS}
            ariaLabel="Edit entity"
          />
          <KindChanger api={api} worldId={worldId} kind={kind} id={entity.id} />
        </>
      ) : (
        <ReadOnlyView
          entity={entity}
          worldId={worldId}
          nameIndex={nameIndex}
          body={String(entity.body ?? entity.description ?? '')}
        />
      )}
      {/*
        `body` is the server-composed prose — the base description plus the
        passages this viewer may see. The EntityEditor above deliberately keeps
        editing `description`, the raw base column: pointing it at `body` would
        fold every visible passage into the base field on the next save.

        While an owner is mid-edit, `editedBody` wins so the panel tracks what
        they are typing; otherwise it reads the composed whole, so a link that
        lives in a passage still lists the entity it points at.
      */}
      <LinkedEntitiesPanel
        text={editedBody ?? String(entity.body ?? entity.description ?? '')}
        worldId={worldId}
        nameIndex={nameIndex}
        kind={kind}
        entityId={entity.id}
        candidates={candidates}
        canEdit={role === 'owner'}
      />
      {visibilityPanel}
      {passagesPanel}
      {proposePanel}
      <EntityMediaPanel worldId={worldId} kind={kind} id={entity.id} canEdit={role === 'owner'} />
      <EntityMaps kind={kind} id={entity.id} />
      <EntitySessions kind={kind} id={entity.id} />
    </>
  )
}
