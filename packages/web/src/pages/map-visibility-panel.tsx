import type { Visibility } from '@campaign-settings/shared'
import { useCallback, useEffect, useState } from 'react'
import type { ApiClient, MemberView } from '../api'
import { errorMessage } from '../app/error-message'
import { Panel } from '../components/panel'
import { ErrorText } from '../components/status'
import { VisibilityControl } from './visibility-panel'

/**
 * Who can see this map, and — when it is restricted — exactly which players.
 *
 * Maps were the one place per-player visibility did not work: `restricted` was
 * refused outright, because a grant naming a map could not be stored in
 * `entity_visibility`. Migration 0016 gave maps their own ACL, so this is now
 * the same control the entity page and each passage use, pointed at a third
 * subject — see `visibility-panel.tsx`.
 *
 * Sharing a map shares the MAP. The per-pin filter still applies on top: a
 * granted player does not see pins whose target entity they cannot see.
 */
export function MapVisibilityPanel({
  api,
  worldId,
  mapId,
  initialVisibility,
}: {
  api: ApiClient
  worldId: string
  mapId: string
  initialVisibility: Visibility
}): React.JSX.Element {
  const [members, setMembers] = useState<MemberView[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      // The owner sees everything, so offering to grant them access would be a
      // control that cannot change anything.
      setMembers((await api.listMembers(worldId)).filter((m) => m.role !== 'owner'))
    } catch (err) {
      setError(errorMessage(err, 'Could not load who can see this map'))
    }
  }, [api, worldId])

  useEffect(() => {
    void load()
  }, [load])

  return (
    <Panel ariaLabel="Who can see this map">
      <h3>Who can see this map</h3>
      <p className="empty-state">
        Sharing a map shares the map itself. Players still only see pins pointing at entries they
        are allowed to see.
      </p>
      <ErrorText>{error}</ErrorText>
      <VisibilityControl
        subject={{
          noun: 'map',
          setVisibility: async (next) => {
            await api.updateMap(worldId, mapId, { visibility: next })
          },
          listGrants: () => api.listMapGrants(worldId, mapId),
          grant: (accountId) => api.grantMapAccess(worldId, mapId, accountId),
          revoke: (accountId) => api.revokeMapAccess(worldId, mapId, accountId),
        }}
        members={members}
        initialVisibility={initialVisibility}
      />
    </Panel>
  )
}
