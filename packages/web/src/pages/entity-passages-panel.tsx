import type { Visibility } from '@campaign-settings/shared'
import { useCallback, useEffect, useState } from 'react'
import type { ApiClient, MemberView, Passage } from '../api'
import { errorMessage } from '../app/error-message'
import { Button } from '../components/button'
import { SelectField } from '../components/field'
import { Panel } from '../components/panel'
import { EmptyState, ErrorText, Loading } from '../components/status'
import { TextAreaField } from '../components/text-area-field'
import { VisibilityControl } from './visibility-panel'

/**
 * Reveal an entity in stages.
 *
 * An entity's own visibility is all-or-nothing, so an NPC whose write-up is
 * half public face and half spoiler cannot be shown at all without showing the
 * spoiler. A passage is a chunk of that write-up with its own visibility, and
 * this is where the owner manages them.
 *
 * OWNER ONLY, and deliberately separate from the prose. The reader view renders
 * the composed body as continuous text — that is what a passage is FOR, reading
 * as one page — so interleaving edit controls into it would turn the thing being
 * revealed into a form. Management lives here instead.
 *
 * The server is what enforces any of this: every route behind these controls is
 * owner-gated, and `http-passages.test.ts` asserts a player's attempt draws a
 * 403 rather than trusting this component not to render.
 */
export function EntityPassagesPanel({
  api,
  worldId,
  kind,
  entityId,
  onChanged,
}: {
  api: ApiClient
  worldId: string
  kind: string
  entityId: string
  /** Called after any change, so the page can re-read its composed body. */
  onChanged: () => void
}): React.JSX.Element {
  const [passages, setPassages] = useState<Passage[] | null>(null)
  const [members, setMembers] = useState<MemberView[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      const [rows, everyone] = await Promise.all([
        api.listPassages(worldId, kind, entityId),
        api.listMembers(worldId),
      ])
      setPassages(rows)
      // The owner sees everything, so offering to grant them access would be a
      // control that cannot change anything.
      setMembers(everyone.filter((m) => m.role !== 'owner'))
    } catch (err) {
      setError(errorMessage(err, 'Could not load the reveals on this page'))
    }
  }, [api, worldId, kind, entityId])

  useEffect(() => {
    void load()
  }, [load])

  /** Re-read after every mutation, and tell the page its body changed. */
  async function refresh(): Promise<void> {
    setPassages(await api.listPassages(worldId, kind, entityId))
    onChanged()
  }

  async function act(what: string, fn: () => Promise<unknown>): Promise<void> {
    setError(null)
    setBusy(true)
    try {
      await fn()
      await refresh()
    } catch (err) {
      setError(errorMessage(err, what))
    } finally {
      setBusy(false)
    }
  }

  /** Only reachable while the Add button is enabled, i.e. the draft is non-empty. */
  async function onAdd(): Promise<void> {
    // No visibility is sent: the column defaults to dm_only, so a new reveal
    // starts hidden and the owner opens it deliberately.
    await act('Could not add that reveal', async () => {
      await api.createPassage(worldId, kind, entityId, {
        body: draft,
        position: (passages?.length ?? 0) + 1,
      })
      setDraft('')
    })
  }

  /**
   * Swap this passage's position with its neighbour's.
   *
   * Two writes rather than a reindex of the whole list: only these two rows
   * change, and a failure between them leaves an order that is merely wrong
   * rather than a list where several rows claim the same slot.
   */
  async function onMove(a: Passage, b: Passage): Promise<void> {
    await act('Could not reorder that reveal', async () => {
      await api.updatePassage(worldId, a.id, { position: b.position })
      await api.updatePassage(worldId, b.id, { position: a.position })
    })
  }

  if (error !== null && passages === null) return <ErrorText>{error}</ErrorText>
  if (passages === null) return <Loading />

  // Proposals are shown apart from the DM's own reveals: they are not yet part
  // of the page, and mixing them into the reorderable list would invite editing
  // someone else's words before deciding whether to take them at all.
  const published = passages.filter((p) => p.status === 'published')
  const proposed = passages.filter((p) => p.status === 'proposed')

  return (
    <Panel ariaLabel="Staged reveals">
      <h3>Reveals</h3>
      <p className="empty-state">
        Everything here is added to the page after its description, for the people you choose. A new
        reveal starts visible to you alone.
      </p>
      <ErrorText>{error}</ErrorText>

      {proposed.length > 0 ? (
        <section aria-label="Suggestions awaiting review">
          <h4>Suggested by players</h4>
          <ul>
            {proposed.map((p) => (
              <li key={p.id}>
                <ProposalRow
                  passage={p}
                  busy={busy}
                  onAccept={(visibility) =>
                    void act('Could not accept that suggestion', () =>
                      api.acceptPassage(worldId, p.id, visibility),
                    )
                  }
                  onReject={() =>
                    void act('Could not reject that suggestion', () =>
                      api.rejectPassage(worldId, p.id),
                    )
                  }
                />
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {published.length === 0 ? (
        <EmptyState>No reveals yet — the page shows only its description.</EmptyState>
      ) : (
        <ol>
          {published.map((p, i) => {
            // The neighbours are resolved HERE, where "there isn't one" is a
            // real case (the first and last rows) rather than inside onMove,
            // where it could never happen and would be an unreachable guard.
            const prev = published[i - 1]
            const next = published[i + 1]
            return (
              <li key={p.id}>
                <PassageRow
                  api={api}
                  worldId={worldId}
                  passage={p}
                  members={members}
                  busy={busy}
                  onMoveUp={prev === undefined ? undefined : () => void onMove(p, prev)}
                  onMoveDown={next === undefined ? undefined : () => void onMove(p, next)}
                  onSave={(body) =>
                    void act('Could not save that reveal', () =>
                      api.updatePassage(worldId, p.id, { body }),
                    )
                  }
                  onDelete={() =>
                    void act('Could not delete that reveal', () => api.deletePassage(worldId, p.id))
                  }
                />
              </li>
            )
          })}
        </ol>
      )}

      <TextAreaField
        label="New reveal"
        ariaLabel="New reveal"
        value={draft}
        onChange={setDraft}
        rows={3}
      />
      <Button disabled={busy || draft.trim() === ''} onClick={() => void onAdd()}>
        Add reveal
      </Button>
    </Panel>
  )
}

/** One passage: its text, who can see it, and the controls that change either. */
function PassageRow({
  api,
  worldId,
  passage,
  members,
  busy,
  onMoveUp,
  onMoveDown,
  onSave,
  onDelete,
}: {
  api: ApiClient
  worldId: string
  passage: Passage
  members: MemberView[] | null
  busy: boolean
  /** Absent at the top of the list — no neighbour to swap with. */
  onMoveUp?: (() => void) | undefined
  /** Absent at the bottom of the list. */
  onMoveDown?: (() => void) | undefined
  onSave: (body: string) => void
  onDelete: () => void
}): React.JSX.Element {
  const [body, setBody] = useState(passage.body)
  const [confirming, setConfirming] = useState(false)
  const label = passage.body.slice(0, 40) || 'Empty reveal'

  return (
    <>
      <TextAreaField
        label={`Reveal: ${label}`}
        ariaLabel={`Reveal ${label}`}
        value={body}
        onChange={setBody}
        rows={3}
      />
      <Button
        variant="secondary"
        disabled={busy || body === passage.body}
        onClick={() => onSave(body)}
      >
        {`Save ${label}`}
      </Button>{' '}
      <Button variant="secondary" disabled={busy || !onMoveUp} onClick={onMoveUp}>
        {`Move ${label} up`}
      </Button>{' '}
      <Button variant="secondary" disabled={busy || !onMoveDown} onClick={onMoveDown}>
        {`Move ${label} down`}
      </Button>{' '}
      {confirming ? (
        <>
          <Button variant="danger" disabled={busy} onClick={onDelete}>
            {`Really delete ${label}`}
          </Button>{' '}
          <Button variant="secondary" disabled={busy} onClick={() => setConfirming(false)}>
            Cancel
          </Button>
        </>
      ) : (
        <Button variant="secondary" disabled={busy} onClick={() => setConfirming(true)}>
          {`Delete ${label}`}
        </Button>
      )}
      <VisibilityControl
        subject={{
          noun: 'reveal',
          setVisibility: async (next: Visibility) => {
            await api.updatePassage(worldId, passage.id, { visibility: next })
          },
          listGrants: () => api.listPassageGrants(worldId, passage.id),
          grant: (accountId) => api.grantPassageAccess(worldId, passage.id, accountId),
          revoke: (accountId) => api.revokePassageAccess(worldId, passage.id, accountId),
        }}
        members={members}
        initialVisibility={passage.visibility}
        labelPrefix={`Reveal ${label}`}
      />
    </>
  )
}

/**
 * One player suggestion, awaiting the GM's decision.
 *
 * Read-only text: the point of a proposal is what the player actually wrote,
 * and an editable box would quietly turn "accept their suggestion" into "accept
 * my rewrite of it". Accepting requires CHOOSING a visibility, because a
 * suggestion the DM likes is not automatically something the whole party knows.
 */
function ProposalRow({
  passage,
  busy,
  onAccept,
  onReject,
}: {
  passage: Passage
  busy: boolean
  onAccept: (visibility: Visibility) => void
  onReject: () => void
}): React.JSX.Element {
  const [visibility, setVisibility] = useState<Visibility>('public')
  const label = passage.body.slice(0, 40) || 'Empty suggestion'

  return (
    <>
      <blockquote>{passage.body}</blockquote>
      <SelectField
        label="Publish as"
        ariaLabel={`Publish ${label} as`}
        value={visibility}
        onChange={(v) => setVisibility(v as Visibility)}
        options={[
          { value: 'public', label: 'Everyone in the world' },
          { value: 'dm_only', label: 'Only you (GM)' },
          { value: 'restricted', label: 'Only the players you choose' },
        ]}
      />
      <Button disabled={busy} onClick={() => onAccept(visibility)}>
        {`Accept ${label}`}
      </Button>{' '}
      <Button variant="secondary" disabled={busy} onClick={onReject}>
        {`Reject ${label}`}
      </Button>
    </>
  )
}
