import { useCallback } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useApi } from '../app/api-context'
import { useResource } from '../app/use-resource'
import { Badge } from '../components/badge'

/**
 * An entity's appearance history: the sessions that touch or bracket it. Purely
 * supplementary — it renders nothing while loading, on error, or when empty, so
 * an entity that has never appeared in a session shows no stray section.
 */
export function EntitySessions({
  kind,
  id,
}: {
  kind: string
  id: string
}): React.JSX.Element | null {
  const api = useApi()
  const { worldId = '' } = useParams()
  const fetcher = useCallback(
    () => api.listEntitySessions(worldId, kind, id),
    [api, worldId, kind, id],
  )
  const { data: sessions } = useResource(fetcher)

  if (!sessions || sessions.length === 0) return null
  return (
    <section aria-label="Session history">
      <h3>Sessions</h3>
      <ul>
        {sessions.map((s) => (
          <li key={s.id}>
            <Link to={`/worlds/${worldId}/session/${s.id}`}>{s.name}</Link>
            {s.played_at ? ` — ${s.played_at}` : ''} <Badge className="link-type">{s.link}</Badge>
          </li>
        ))}
      </ul>
    </section>
  )
}
