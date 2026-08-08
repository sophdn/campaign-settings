import { findKindEntry, type NameIndex } from '@campaign-settings/shared'
import { useCallback, useState } from 'react'
import type { Entity, Suggestion } from '../api'
import { useApi } from '../app/api-context'
import { errorMessage } from '../app/error-message'
import { useWikiIndex } from '../app/use-name-index'
import { useResource } from '../app/use-resource'
import { useWorld } from '../app/world-context'
import { Button } from '../components/button'
import { EntityDescription } from '../components/entity-description'
import { PageHeader } from '../components/page-header'
import { ResourceView } from '../components/resource-view'
import { SegmentedToggle } from '../components/segmented-toggle'
import { EmptyState, ErrorText } from '../components/status'

/** "processed" folds the two terminal states; "pending" is awaiting review. */
type StatusFilter = 'all' | 'pending' | 'processed'
const STATUS_FILTERS: { value: StatusFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'pending', label: 'Pending' },
  { value: 'processed', label: 'Processed' },
]
const matchesFilter = (s: Suggestion, filter: StatusFilter): boolean =>
  filter === 'all' ? true : filter === 'pending' ? s.status === 'pending' : s.status !== 'pending'

// Only content kinds (those with a dm_only column) are suggestable targets;
// the server rejects pc/session/map with 403, so they must not appear here.

const entityName = (e: Entity): string => (typeof e.name === 'string' ? e.name : '')
const kindLabelOf = (kind: string | null): string =>
  kind ? (findKindEntry(kind)?.label.singular ?? kind) : '?'

/** One suggestion row: resolves the target's name, shows type — name — body. */
function SuggestionRow({
  suggestion: s,
  worldId,
  role,
  nameIndex,
  onAccept,
  onReject,
}: {
  suggestion: Suggestion
  worldId: string
  role: string
  nameIndex: NameIndex
  onAccept: () => void
  onReject: () => void
}): React.JSX.Element {
  const api = useApi()
  const kind = s.target_entity_kind
  const id = s.target_entity_id
  const fetcher = useCallback(
    () => (kind && id ? api.getEntity(worldId, kind, id) : Promise.resolve(null)),
    [api, worldId, kind, id],
  )
  const { data: entity } = useResource(fetcher)
  const name = entity ? entityName(entity) || (id ?? '?') : (id ?? '?')
  const body =
    typeof s.proposed.description === 'string' && s.proposed.description.length > 0
      ? s.proposed.description
      : JSON.stringify(s.proposed)

  return (
    <li className="suggestion">
      <div className="suggestion-target">
        <strong>{kindLabelOf(kind)}</strong> — <span className="suggestion-name">{name}</span>
      </div>
      <EntityDescription text={body} worldId={worldId} nameIndex={nameIndex} />
      {role === 'owner' ? (
        <div className="suggestion-actions">
          <Button type="button" onClick={onAccept}>
            Accept
          </Button>
          <Button variant="danger" type="button" onClick={onReject}>
            Reject
          </Button>
        </div>
      ) : null}
    </li>
  )
}

/** Player suggestion queue: players propose edits; the DM accepts or rejects. */
export function SuggestionsPage(): React.JSX.Element {
  const api = useApi()
  const { worldId, role } = useWorld()
  const fetcher = useCallback(() => api.listSuggestions(worldId), [api, worldId])
  const suggestionsRes = useResource(fetcher)
  const { reload } = suggestionsRes
  const { nameIndex } = useWikiIndex(worldId)
  const [actionError, setActionError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [filter, setFilter] = useState<StatusFilter>('all')

  async function run(op: () => Promise<unknown>, successMsg?: string): Promise<void> {
    setActionError(null)
    setNotice(null)
    try {
      await op()
      if (successMsg) setNotice(successMsg)
      reload()
    } catch (err) {
      setActionError(errorMessage(err, 'Failed'))
    }
  }

  return (
    <section>
      <PageHeader title="Suggestions" />
      {/*
        The authoring form that used to live here is gone. Suggesting an
        addition now happens on the entity's own page (ProposePassagePanel),
        where the player is already reading the thing they mean and the GM
        reviews it in place rather than in a disconnected queue.

        This screen stays as the REVIEW surface for suggestions made the old
        way. The table, its routes and its accept/reject flow are untouched, so
        nothing already in the queue is stranded — retiring them is a later
        decision, not this change's to make.
      */}
      <ErrorText>{actionError}</ErrorText>
      {notice ? <p role="status">{notice}</p> : null}
      <section className="list-section">
        <div className="list-head">
          <h2>My Suggestions</h2>
          <SegmentedToggle
            label="Filter suggestions"
            value={filter}
            onChange={setFilter}
            options={STATUS_FILTERS}
          />
        </div>
        <ResourceView
          resource={suggestionsRes}
          empty={(all) => all.length === 0}
          emptyLabel={<EmptyState>No suggestions yet.</EmptyState>}
        >
          {(all) => {
            const visible = all.filter((s) => matchesFilter(s, filter))
            return visible.length === 0 ? (
              <EmptyState>No {filter} suggestions.</EmptyState>
            ) : (
              <ul className="suggestion-list">
                {visible.map((s) => (
                  <SuggestionRow
                    key={s.id}
                    suggestion={s}
                    worldId={worldId}
                    role={role}
                    nameIndex={nameIndex}
                    onAccept={() => void run(() => api.acceptSuggestion(worldId, s.id))}
                    onReject={() => void run(() => api.rejectSuggestion(worldId, s.id))}
                  />
                ))}
              </ul>
            )
          }}
        </ResourceView>
      </section>
    </section>
  )
}
