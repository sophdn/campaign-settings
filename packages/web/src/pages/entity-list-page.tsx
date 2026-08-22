import { findKindEntry } from '@campaign-settings/shared'
import { type FormEvent, useCallback, useState } from 'react'
import { useParams } from 'react-router-dom'
import { useApi } from '../app/api-context'
import { errorMessage } from '../app/error-message'
import { useResource } from '../app/use-resource'
import { useIsOwner } from '../app/world-context'
import { Button } from '../components/button'
import { CardLink } from '../components/card-link'
import { PageHeader } from '../components/page-header'
import { ResourceView } from '../components/resource-view'
import { EmptyState, ErrorText } from '../components/status'

export function EntityListPage(): React.JSX.Element {
  const api = useApi()
  const isOwner = useIsOwner()
  const { worldId = '', kind = '' } = useParams()
  const fetcher = useCallback(() => api.listEntities(worldId, kind), [api, worldId, kind])
  const entitiesRes = useResource(fetcher)
  const { reload } = entitiesRes
  const [name, setName] = useState('')
  const [createError, setCreateError] = useState<string | null>(null)
  const label = findKindEntry(kind)?.label.plural ?? kind

  async function onCreate(e: FormEvent): Promise<void> {
    e.preventDefault()
    setCreateError(null)
    try {
      await api.createEntity(worldId, kind, { name })
      setName('')
      reload()
    } catch (err) {
      setCreateError(errorMessage(err, 'Create failed'))
    }
  }

  return (
    <section>
      <PageHeader title={label} />
      {isOwner ? (
        <form onSubmit={(e) => void onCreate(e)} aria-label={`New ${kind}`}>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Name"
            aria-label="Name"
          />
          <Button type="submit">Add</Button>
        </form>
      ) : null}
      <ErrorText>{createError}</ErrorText>
      <ResourceView
        resource={entitiesRes}
        empty={(entities) => entities.length === 0}
        emptyLabel={<EmptyState>No {label.toLowerCase()} yet.</EmptyState>}
      >
        {(entities) => (
          <ul className="card-grid">
            {entities.map((ent) => (
              <CardLink key={ent.id} to={ent.id} title={String(ent.name ?? ent.id)} />
            ))}
          </ul>
        )}
      </ResourceView>
    </section>
  )
}
