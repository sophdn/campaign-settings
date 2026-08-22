import { useCallback } from 'react'
import { Link } from 'react-router-dom'
import { useApi } from '../app/api-context'
import { useResource } from '../app/use-resource'
import { Badge } from '../components/badge'
import { Panel } from '../components/panel'
import { EmptyState, ErrorText, Loading } from '../components/status'

/**
 * Who uses this currency — the settlements and organizations that hold an
 * attachment to it.
 *
 * This is the CROSS-REFERENCE SECTION chain 398's completion condition asked for
 * and never got for the two attachment tables. The forward direction lives on the
 * owner's page (`currency-attachments-panel.tsx`); this is the same rows read
 * from the other end, so a GM can answer "who actually takes the Iron Mark"
 * without opening every settlement in the world.
 *
 * Read-only by design, for both roles. Attaching is an act performed ON an owner
 * — it needs that owner's page to say which one — and a second write path into
 * the same rows would be a second place for the primary semantics to live.
 *
 * The filtering is entirely server-side and doubly so: the row's own
 * `visibility`, and the OWNER's, because telling a player that a `dm_only`
 * settlement uses this coin reports that settlement's name and existence just as
 * surely as the forward direction would report a hidden currency's.
 */
export function CurrencyUsersPanel({
  worldId,
  currencyId,
}: {
  worldId: string
  currencyId: string
}): React.JSX.Element {
  const api = useApi()
  const fetcher = useCallback(
    () => api.listCurrencyUsers(worldId, currencyId),
    [api, worldId, currencyId],
  )
  const { data, loading, error } = useResource(fetcher)
  // Defaulted once — `data` is null while loading and after a failed read.
  const users = data ?? []

  return (
    <Panel ariaLabel="Used by">
      <h3>Used by</h3>
      <ErrorText>{error}</ErrorText>
      {loading ? (
        <Loading />
      ) : users.length === 0 ? (
        <EmptyState>Nowhere in this world uses this currency yet.</EmptyState>
      ) : (
        <ul className="currency-user-list">
          {users.map((user) => (
            <li key={user.attachmentId}>
              <Link to={`/worlds/${worldId}/${user.ownerKind}/${user.ownerId}`}>
                {user.ownerName}
              </Link>
              {user.isPrimary ? <Badge>Primary</Badge> : null}
              {user.notes === '' ? null : <span className="muted">{user.notes}</span>}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  )
}
