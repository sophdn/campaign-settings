import { type FormEvent, useCallback, useState } from 'react'
import { type TouchType, TOUCH_TYPES } from '../api'
import { useApi } from '../app/api-context'
import { errorMessage } from '../app/error-message'
import { useResource } from '../app/use-resource'
import { useParams } from 'react-router-dom'
import { Badge } from '../components/badge'
import { Button } from '../components/button'
import { ResourceView } from '../components/resource-view'
import { EmptyState, ErrorText } from '../components/status'
import { kindLabel } from './kind-color'

/**
 * The structured interaction records (EntityTouches) for a session — "the party
 * MET this NPC", "KILLED that monster". The DM adds/removes them; players see
 * the list read-only. Entity names resolve through the wiki list; the picker is
 * sourced from it too (sessions excluded — you don't touch a session).
 */
export function SessionTouches({
  sessionId,
  isOwner,
}: {
  sessionId: string
  /** Presentation only, per the rule on `useIsOwner`; the endpoints refuse a player regardless. */
  isOwner: boolean
}): React.JSX.Element {
  const api = useApi()
  const { worldId = '' } = useParams()
  const touchesFetcher = useCallback(
    () => api.listTouches(worldId, sessionId),
    [api, worldId, sessionId],
  )
  const touchesRes = useResource(touchesFetcher)
  const { reload } = touchesRes
  const wikiFetcher = useCallback(() => api.listWiki(worldId), [api, worldId])
  const { data: entities } = useResource(wikiFetcher)

  const [entityKey, setEntityKey] = useState('')
  const [touchType, setTouchType] = useState<TouchType>('met')
  const [actionError, setActionError] = useState<string | null>(null)

  // Touches no longer carry the kind; the entity id is globally unique, so resolve
  // the name by id alone against the wiki list.
  const nameOf = (id: string): string => entities?.find((e) => e.id === id)?.name ?? id

  async function onAdd(e: FormEvent): Promise<void> {
    e.preventDefault()
    setActionError(null)
    const sep = entityKey.indexOf(':')
    if (sep < 0) return
    const entityId = entityKey.slice(sep + 1)
    try {
      await api.createTouch(worldId, sessionId, { entityId, touchType })
      setEntityKey('')
      reload()
    } catch (err) {
      setActionError(errorMessage(err, 'Failed'))
    }
  }

  async function onRemove(id: string): Promise<void> {
    setActionError(null)
    try {
      await api.deleteTouch(worldId, sessionId, id)
      reload()
    } catch (err) {
      setActionError(errorMessage(err, 'Failed'))
    }
  }

  const pickable = (entities ?? []).filter((e) => e.kind !== 'session')

  return (
    <section aria-label="Interactions">
      <h3>Interactions</h3>
      {isOwner ? (
        <form onSubmit={(e) => void onAdd(e)} aria-label="Add interaction">
          <select
            value={entityKey}
            onChange={(e) => setEntityKey(e.target.value)}
            aria-label="Entity"
          >
            <option value="">Pick an entity…</option>
            {pickable.map((e) => (
              <option key={`${e.kind}:${e.id}`} value={`${e.kind}:${e.id}`}>
                {e.name} ({kindLabel(e.kind)})
              </option>
            ))}
          </select>
          <select
            value={touchType}
            onChange={(e) => setTouchType(e.target.value as TouchType)}
            aria-label="Interaction type"
          >
            {TOUCH_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          <Button type="submit" disabled={!entityKey}>
            Add interaction
          </Button>
        </form>
      ) : null}
      <ErrorText>{actionError}</ErrorText>
      <ResourceView
        resource={touchesRes}
        empty={(touches) => touches.length === 0}
        emptyLabel={<EmptyState>No interactions logged yet.</EmptyState>}
      >
        {(touches) => (
          <ul className="card-grid">
            {touches.map((t) => (
              <li key={t.id} className="card-link-item">
                <div className="entity-card">
                  <Badge className="touch-type">{t.touch_type}</Badge>
                  <span className="card-link-title">{nameOf(t.entity_id)}</span>
                  {isOwner ? (
                    <Button variant="danger" type="button" onClick={() => void onRemove(t.id)}>
                      Remove
                    </Button>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </ResourceView>
    </section>
  )
}
