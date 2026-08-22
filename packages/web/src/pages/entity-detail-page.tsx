import {
  contentKinds,
  type FieldDef,
  fieldsForKindName,
  type NameIndex,
  type Visibility,
} from '@campaign-settings/shared'
import { Fragment, type ReactNode, useCallback, useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import type { ApiClient, Entity, MemberView, WikiEntry } from '../api'
import { useApi } from '../app/api-context'
import { errorMessage } from '../app/error-message'
import { useWikiIndex } from '../app/use-name-index'
import { useResource } from '../app/use-resource'
import { useIsOwner } from '../app/world-context'
import { AccordionPanel } from '../components/accordion-panel'
import { BackLink } from '../components/back-link'
import { Button } from '../components/button'
import { EntityDescription } from '../components/entity-description'
import { SelectField, TextField } from '../components/field'
import { FormCard } from '../components/form-card'
import { Panel } from '../components/panel'
import { ErrorText, Loading } from '../components/status'
import { TextAreaField } from '../components/text-area-field'
import { initialFieldValues, toEntityPatch } from '../components/typed-field-values'
import {
  type AccountCandidates,
  ImportedMetadata,
  TypedFieldInputs,
  TypedFieldList,
} from '../components/typed-fields'
import { CurrencyAttachmentsPanel } from './currency-attachments-panel'
import { CurrencyPanel } from './currency-panel'
import { CurrencyUsersPanel } from './currency-users-panel'
import { EntityAvatar } from './entity-avatar'
import { EntityMediaPanel } from './entity-media-panel'
import { EntitySessions } from './entity-sessions'
import { EntityPassagesPanel } from './entity-passages-panel'
import { ProposePassagePanel } from './propose-passage-panel'
import { EntityVisibilityPanel } from './entity-visibility-panel'
import { LinkedEntitiesPanel } from './linked-entities-panel'
import { EntityMaps } from './maps-page'
import { SessionTouches } from './session-touches'
import { SessionDateField } from './session-date-field'
import { SettlementDemographicsPanel } from './settlement-demographics-panel'

/** One editable field: its payload/state key, label, and how to read it off the entity. */
interface EditorField {
  key: string
  label: string
  multiline?: boolean
  placeholder?: string
  initial: (entity: Entity) => string
  /** When set, a live [[...]] preview of this field renders under it. */
  previewLabel?: string
  /**
   * Render this field through the calendar-aware session date control instead of a
   * plain text input. A marker rather than a component so `EditorField` stays a
   * plain descriptor — and so the calendar read stays scoped to sessions, which are
   * the only kind with a `played_at`.
   */
  calendarDate?: boolean
}

// The fields every kind shares. A kind's OWN typed fields come from the shared
// registry and render after these — see `typedFields` below. A session is
// bespoke — a played_at date and a captured_text recap where [[mentions]]
// become graph bracket-edges — and has no registry entry at all.
const CORE_FIELDS: EditorField[] = [
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
    // Driven by the world's ACTIVE calendar; falls back to this plain field when
    // the world has none. See `session-date-field.tsx`.
    calendarDate: true,
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
  /** World members, for an `accountRef` field. Null until they load. */
  members?: AccountCandidates
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
  members = null,
  fields,
  typedFields,
  ariaLabel,
}: EditorProps & {
  fields: EditorField[]
  typedFields: readonly FieldDef[]
  ariaLabel: string
}): React.JSX.Element {
  const [values, setValues] = useState<Record<string, string>>(() => ({
    ...Object.fromEntries(fields.map((f) => [f.key, f.initial(entity)])),
    ...initialFieldValues(typedFields, entity),
  }))
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
      // The core fields are strings by construction; the typed ones are coerced
      // to the column's actual type, so a save carries the whole entity rather
      // than name + description with everything else left behind.
      const payload = {
        ...Object.fromEntries(fields.map((f) => [f.key, values[f.key] ?? ''])),
        ...toEntityPatch(typedFields, values),
      }
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
          {f.calendarDate ? (
            <SessionDateField
              worldId={worldId}
              value={values[f.key] ?? ''}
              onChange={(v) => set(f.key, v)}
            />
          ) : f.multiline ? (
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
      <TypedFieldInputs
        fields={typedFields}
        values={values}
        onChange={set}
        candidates={candidates}
        members={members}
      />
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
 * The world's members, but ONLY for a kind that has somewhere to put them.
 *
 * A PC page needs them for its "Played by" picker; the other fifteen kinds have
 * no `accountRef` field, and fetching a member list on every NPC page would be
 * one request per page view spent on a control that is not rendered. Asking the
 * registry rather than testing `kind === 'pc'` means a second kind that grows
 * an account field needs no change here.
 *
 * Returns null while loading AND on failure — the picker renders a disabled
 * placeholder either way, which is the right outcome for a control whose
 * options could not be fetched. The page itself must not fail over this: the
 * character's name and prose are still worth showing.
 */
function useAccountCandidates(worldId: string, kind: string): AccountCandidates {
  const api = useApi()
  const needed = fieldsForKindName(kind).some((f) => f.type === 'accountRef')
  const [members, setMembers] = useState<MemberView[] | null>(null)

  useEffect(() => {
    if (!needed) {
      setMembers(null)
      return
    }
    let cancelled = false
    void (async () => {
      try {
        const rows = await api.listMembers(worldId)
        if (!cancelled) setMembers(rows)
      } catch {
        // Deliberately swallowed — see the docstring.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [api, worldId, needed])

  return needed ? members : null
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
    <AccordionPanel title="Type">
      <p className="muted">
        Reclassify this entity. Type-specific fields are cleared when the type changes.
      </p>
      {/* The button sits BESIDE the dropdown, not under it. It used to sit
          under it because the field wrapper is a full-width flex COLUMN, which
          made the button the column's next row; `.inline-control` is a flex row
          that lets the select take the space and the button take its own. */}
      <div className="inline-control">
        <SelectField
          label="Type"
          // The panel heading already says "Type". Visible label dropped, name
          // kept — the component tests find this control by that name.
          hideLabel
          value={toKind}
          onChange={setToKind}
          options={options}
        />
        <Button type="button" onClick={() => void onChange()} disabled={toKind === kind}>
          Change type
        </Button>
      </div>
      {status ? <p role="status">{status}</p> : null}
    </AccordionPanel>
  )
}

/**
 * The readable view of an entity or session: its name, its prose, its typed
 * fields. THE read view — an owner gets this same component, not a fork of it,
 * with the editor collapsed behind the pencil `action` renders. Two views that
 * drifted apart would mean the GM never sees what they are publishing.
 */
function ReadOnlyView({
  entity,
  worldId,
  kind,
  nameIndex,
  candidates,
  body,
  date,
  members = null,
  action,
  canEdit,
  avatarKey = 0,
  onPrimaryChanged,
}: {
  entity: Entity
  worldId: string
  kind: string
  nameIndex: NameIndex
  candidates: WikiEntry[]
  body: string
  date?: string
  members?: AccountCandidates
  /** Rendered at the far right of the heading row. The owner's pencil. */
  action?: ReactNode
  /** Whether to offer the avatar's plus. Presentation; the server still refuses. */
  canEdit: boolean
  /**
   * Bumped when the gallery changes WHICH image leads the page. Remounting the
   * avatar is enough to make it re-read: it holds one row and no state worth
   * preserving across the change.
   */
  avatarKey?: number
  /** Told when the avatar's plus nominates one, so the gallery re-reads too. */
  onPrimaryChanged?: (() => void) | undefined
}): React.JSX.Element {
  // The block is NAMED so the read prose is addressable on its own — the hidden
  // editor holds a copy of the same text. Deliberately not named after the kind:
  // "Currency" would collide with the CurrencyPanel's own region on the same
  // page, and two regions sharing one name is worse than one generic name.
  return (
    <Panel ariaLabel="Entry">
      {/* Above the name, so art on a character has prominence instead of
          sitting in a row of thumbnails past every other panel. */}
      <EntityAvatar
        key={avatarKey}
        worldId={worldId}
        kind={kind}
        id={String(entity.id)}
        canEdit={canEdit}
        onPrimaryChanged={onPrimaryChanged}
      />
      <div className="panel-head">
        <h2>{String(entity.name ?? entity.id)}</h2>
        {action ?? null}
      </div>
      {date ? <p>{date}</p> : null}
      <EntityDescription text={body} worldId={worldId} nameIndex={nameIndex} />
      <TypedFieldList
        kind={kind}
        entity={entity}
        worldId={worldId}
        candidates={candidates}
        members={members}
      />
    </Panel>
  )
}

/**
 * An entity block that opens READABLE, with its editor collapsed behind a pencil.
 *
 * ## Why show/hide rather than mount/unmount
 *
 * Closing the pencil is not Cancel. An owner who opens the editor, types three
 * paragraphs, folds it away to re-read the page and opens it again must find
 * their work where they left it. So the editor stays mounted and is hidden with
 * the `hidden` attribute, which also takes it out of the tab order and off the
 * accessibility tree — that is what satisfies "Delete is not reachable while the
 * form is collapsed" without a second guard inside the form.
 *
 * Unmounting would be simpler and would silently discard the draft, which is the
 * failure this page is being changed to avoid rather than introduce.
 *
 * ## Why one toggle for the page, not one per field
 *
 * The complaint was the space the form takes on ARRIVAL, not the granularity of
 * editing. Per-field pencils would mean splitting one form and one save path
 * into several, which is a much larger change answering a question nobody asked.
 */
function CollapsibleEditor({
  readView,
  editor,
  label,
}: {
  /** The prose view, handed the pencil to render in its heading row. */
  readView: (pencil: ReactNode) => ReactNode
  editor: ReactNode
  /** Names the thing being edited, so the button reads "Edit entity" / "Edit session". */
  label: string
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const pencil = (
    <Button
      variant="secondary"
      className="edit-toggle"
      type="button"
      aria-expanded={open}
      aria-label={open ? `Hide the ${label} editor` : `Edit ${label}`}
      onClick={() => setOpen((wasOpen) => !wasOpen)}
    >
      <span aria-hidden="true">✎</span>
    </Button>
  )
  return (
    <>
      {readView(pencil)}
      <div hidden={!open}>{editor}</div>
    </>
  )
}

export function EntityDetailPage(): React.JSX.Element {
  const api = useApi()
  const navigate = useNavigate()
  const isOwner = useIsOwner()
  const { worldId = '', kind = '', id = '' } = useParams()
  const fetcher = useCallback(() => api.getEntity(worldId, kind, id), [api, worldId, kind, id])
  const { data: entity, loading, error, reload } = useResource(fetcher)
  const { nameIndex, candidates } = useWikiIndex(worldId)
  const members = useAccountCandidates(worldId, kind)
  // The body currently in the editor; null until it is touched, so a reader with
  // no editor still gets the saved text. Cleared when the page moves to another
  // entity, which happens without a remount.
  const [editedBody, setEditedBody] = useState<string | null>(null)
  // Bumped whenever EITHER surface changes which image leads the page. The
  // avatar and the Images gallery each hold their own read of it, so both are
  // remounted on a change rather than one of them going stale until a reload.
  const [mediaVersion, setMediaVersion] = useState(0)
  const bumpMedia = (): void => setMediaVersion((n) => n + 1)
  // Bumped when a REVEAL is added, edited or deleted. A reveal's `[[links]]`
  // are relationships now, so its text changing changes what the Relationships
  // panel holds — and that panel fetches on its own rather than off the entity.
  const [passageVersion, setPassageVersion] = useState(0)
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
  // The kind's own fields, from the shared registry. Empty for `session`/`map`
  // and for the three kinds that carry nothing beyond name + description, which
  // is why the editor and the read list both handle an empty list as "render
  // nothing extra" rather than as a special case.
  const typedFields = fieldsForKindName(kind)
  // Reveals sit with the visibility control: both answer "who sees what here".
  // Sessions and maps cannot own passages (entity_passages.entity_id is FK'd to
  // `entities`), so the panel is not offered for them.
  const passagesPanel =
    isOwner && kind !== 'session' ? (
      <EntityPassagesPanel
        key={`passages-${entity.id}`}
        api={api}
        worldId={worldId}
        kind={kind}
        entityId={entity.id}
        onChanged={() => {
          reload()
          setPassageVersion((n) => n + 1)
        }}
      />
    ) : null
  // A player's one write. Not offered on sessions, which cannot own passages.
  const proposePanel =
    !isOwner && kind !== 'session' ? (
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
  const visibilityPanel = isOwner ? (
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
        <BackLink to={`/worlds/${worldId}/wiki`}>Back to wiki</BackLink>
        {/* Both roles read the same view. An owner additionally gets the pencil,
            and the editor behind it starts collapsed. */}
        <CollapsibleEditor
          key={`editor-${entity.id}`}
          label="session"
          readView={(pencil) => (
            <ReadOnlyView
              entity={entity}
              worldId={worldId}
              kind="session"
              nameIndex={nameIndex}
              candidates={candidates}
              body={String(entity.captured_text ?? '')}
              date={String(entity.played_at ?? '')}
              canEdit={isOwner}
              avatarKey={mediaVersion}
              onPrimaryChanged={bumpMedia}
              {...(isOwner ? { action: pencil } : {})}
            />
          )}
          editor={
            isOwner ? (
              <EntityEditor
                api={api}
                worldId={worldId}
                kind="session"
                entity={entity}
                nameIndex={nameIndex}
                candidates={candidates}
                onBodyChange={setEditedBody}
                onDeleted={onDeleted}
                fields={SESSION_FIELDS}
                typedFields={[]}
                ariaLabel="Edit session"
              />
            ) : null
          }
        />
        <LinkedEntitiesPanel
          text={editedBody ?? String(entity.captured_text ?? '')}
          worldId={worldId}
          nameIndex={nameIndex}
          kind="session"
          entityId={entity.id}
          candidates={candidates}
          canEdit={isOwner}
        />
        {visibilityPanel}
        <SessionTouches sessionId={entity.id} isOwner={isOwner} />
      </>
    )
  }
  return (
    <>
      <BackLink to={`/worlds/${worldId}/wiki`}>Back to wiki</BackLink>
      <CollapsibleEditor
        key={`editor-${entity.id}`}
        label="entity"
        readView={(pencil) => (
          <ReadOnlyView
            entity={entity}
            worldId={worldId}
            kind={kind}
            nameIndex={nameIndex}
            candidates={candidates}
            body={String(entity.body ?? entity.description ?? '')}
            members={members}
            canEdit={isOwner}
            avatarKey={mediaVersion}
            onPrimaryChanged={bumpMedia}
            {...(isOwner ? { action: pencil } : {})}
          />
        )}
        editor={
          isOwner ? (
            <EntityEditor
              api={api}
              worldId={worldId}
              kind={kind}
              entity={entity}
              nameIndex={nameIndex}
              candidates={candidates}
              onBodyChange={setEditedBody}
              onDeleted={onDeleted}
              members={members}
              fields={CORE_FIELDS}
              typedFields={typedFields}
              ariaLabel="Edit entity"
            />
          ) : null
        }
      />
      {isOwner ? (
        <>
          <KindChanger api={api} worldId={worldId} kind={kind} id={entity.id} />
          <ImportedMetadata entity={entity} />
        </>
      ) : null}
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
        key={`links-${passageVersion}`}
        text={editedBody ?? String(entity.body ?? entity.description ?? '')}
        worldId={worldId}
        nameIndex={nameIndex}
        kind={kind}
        entityId={entity.id}
        candidates={candidates}
        canEdit={isOwner}
      />
      {/*
        A bespoke panel for the one kind that has a model behind it. The generic
        registry-driven surface above renders a settlement's axes as fields;
        this turns the same axes into a population and a denizen census, which
        no field descriptor can express.
      */}
      {kind === 'settlement' ? (
        <SettlementDemographicsPanel
          api={api}
          worldId={worldId}
          entity={entity}
          canEdit={isOwner}
        />
      ) : null}
      {/*
        Deliberately NOT keyed on `entity.id`. It was, and on the built SPA that
        left two-to-four inert `section[aria-label="Currency"]` siblings on the
        page (bug 1221); the panel re-seeds its own state on an id change instead.
        See the comment in `currency-panel.tsx`.
      */}
      {kind === 'currency' ? (
        <CurrencyPanel
          api={api}
          worldId={worldId}
          entity={entity}
          canEdit={isOwner}
          onSaved={reload}
        />
      ) : null}
      {/*
        Which currencies this place uses, and — on a currency — who uses it. ONE
        component serves both owner kinds; see `currency-attachments-panel.tsx`.

        Deliberately NOT keyed on `entity.id`, for the reason the currency panel
        above carries: a `key` here is what produced bug 1221's inert duplicate
        panels on the built SPA. Both panels re-read on an identity change through
        their `useCallback` fetchers instead, and the attach form re-seeds its own
        draft state during render.
      */}
      {kind === 'settlement' || kind === 'organization' ? (
        <CurrencyAttachmentsPanel
          worldId={worldId}
          ownerKind={kind}
          ownerId={entity.id}
          canEdit={isOwner}
        />
      ) : null}
      {kind === 'currency' ? <CurrencyUsersPanel worldId={worldId} currencyId={entity.id} /> : null}
      {visibilityPanel}
      {passagesPanel}
      {proposePanel}
      <EntityMediaPanel
        key={mediaVersion}
        worldId={worldId}
        kind={kind}
        id={entity.id}
        canEdit={isOwner}
        onPrimaryChanged={bumpMedia}
      />
      <EntityMaps kind={kind} id={entity.id} />
      <EntitySessions kind={kind} id={entity.id} />
    </>
  )
}
