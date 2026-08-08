import { useCallback, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useApi } from '../app/api-context'
import { errorMessage } from '../app/error-message'
import { useResource } from '../app/use-resource'
import { useWorld } from '../app/world-context'
import { Badge } from '../components/badge'
import { Button } from '../components/button'
import { CardLink } from '../components/card-link'
import { TextField } from '../components/field'
import { FormCard } from '../components/form-card'
import { PageHeader } from '../components/page-header'
import { ResourceView } from '../components/resource-view'
import { EmptyState } from '../components/status'

/**
 * The world's maps.
 *
 * Maps belong to the WORLD rather than to one entity, so they get an index of
 * their own — a region map shared by two settlements, or a world map belonging
 * to no single place, has somewhere to live. An entity's connection to a map
 * runs the other way, through the pins on it, and surfaces on the entity page
 * as "Pinned on maps".
 */
export function MapsPage(): React.JSX.Element {
  const api = useApi()
  const { role } = useWorld()
  const { worldId = '' } = useParams()
  const fetcher = useCallback(() => api.listMaps(worldId), [api, worldId])
  const resource = useResource(fetcher)

  return (
    <>
      <PageHeader title="Maps" />
      {role === 'owner' ? <NewMapForm worldId={worldId} onCreated={resource.reload} /> : null}
      <ResourceView
        resource={resource}
        empty={(maps) => maps.length === 0}
        emptyLabel={<EmptyState>No maps yet.</EmptyState>}
      >
        {(maps) => (
          <ul className="card-grid">
            {maps.map((m) => (
              <CardLink
                key={m.id}
                to={`/worlds/${worldId}/maps/${m.id}`}
                title={m.name}
                meta={
                  m.visibility === 'dm_only' ? (
                    <Badge color="var(--color-warning-text)">GM only</Badge>
                  ) : undefined
                }
              />
            ))}
          </ul>
        )}
      </ResourceView>
    </>
  )
}

function NewMapForm({
  worldId,
  onCreated,
}: {
  worldId: string
  onCreated: () => void
}): React.JSX.Element {
  const api = useApi()
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)

  async function onSubmit(): Promise<void> {
    setError(null)
    try {
      await api.createMap(worldId, { name })
      setName('')
      onCreated()
    } catch (err) {
      setError(errorMessage(err, 'Could not create the map'))
    }
  }

  return (
    <FormCard ariaLabel="New map" onSubmit={onSubmit}>
      <TextField label="Name" value={name} onChange={setName} placeholder="e.g. Saltmarsh" />
      {error ? <p role="alert">{error}</p> : null}
      <div className="form-actions">
        <Button type="submit" disabled={name.trim() === ''}>
          Add
        </Button>
      </div>
    </FormCard>
  )
}

/** The reverse lookup on an entity page: which maps mark this entity. */
export function EntityMaps({ kind, id }: { kind: string; id: string }): React.JSX.Element | null {
  const api = useApi()
  const { worldId = '' } = useParams()
  const fetcher = useCallback(() => api.listEntityMaps(worldId, kind, id), [api, worldId, kind, id])
  const { data } = useResource(fetcher)
  const maps = data ?? []
  // Renders nothing at all when there is nothing to say — an entity that appears
  // on no map should not carry an empty panel arguing about it.
  if (maps.length === 0) return null

  return (
    <section className="panel" aria-label="Pinned on maps">
      <h3>Pinned on maps</h3>
      <ul className="card-grid">
        {maps.map((m) => (
          <li key={m.pinId}>
            <Link to={`/worlds/${worldId}/maps/${m.mapId}`}>{m.mapName}</Link>
            {m.label ? <span className="field-hint">{m.label}</span> : null}
          </li>
        ))}
      </ul>
    </section>
  )
}
