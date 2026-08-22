import type { Visibility } from '@campaign-settings/shared'
import { useCallback, useEffect, useState } from 'react'
import type { ApiClient, MemberView } from '../api'
import { errorMessage } from '../app/error-message'
import { Panel } from '../components/panel'
import { ErrorText } from '../components/status'
import { VisibilityControl } from './visibility-panel'

/**
 * Who can see this page, and — when it is restricted — exactly which players.
 *
 * The control itself lives in `visibility-panel.tsx` and is shared with
 * passages; this is the entity-shaped adapter around it. The plain-language
 * labels and the retained-grants semantics are defined once, over there, so an
 * entity and a passage can never come to describe visibility differently.
 */
export function EntityVisibilityPanel({
  api,
  worldId,
  kind,
  entityId,
  initialVisibility,
}: {
  api: ApiClient
  worldId: string
  kind: string
  entityId: string
  initialVisibility: Visibility
}): React.JSX.Element {
  const [members, setMembers] = useState<MemberView[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      // The owner always sees everything, so offering to grant them access
      // would be a control that cannot change anything.
      setMembers((await api.listMembers(worldId)).filter((m) => m.role !== 'owner'))
    } catch (err) {
      setError(errorMessage(err, 'Could not load who can see this page'))
    }
  }, [api, worldId])

  useEffect(() => {
    void load()
  }, [load])

  return (
    <Panel ariaLabel="Who can see this">
      <h3>Who can see this</h3>
      <ErrorText>{error}</ErrorText>
      <VisibilityControl
        subject={{
          noun: 'page',
          setVisibility: async (next) => {
            await api.updateEntity(worldId, kind, entityId, { visibility: next })
          },
          listGrants: () => api.listEntityGrants(worldId, kind, entityId),
          grant: (accountId) => api.grantEntityAccess(worldId, kind, entityId, accountId),
          revoke: (accountId) => api.revokeEntityAccess(worldId, kind, entityId, accountId),
        }}
        members={members}
        initialVisibility={initialVisibility}
        // The panel is already headed "Who can see this"; a select labelled
        // "Visibility" under it says the same thing twice. The accessible name
        // is kept, which is what the component tests assert on.
        hideLabel
      />
    </Panel>
  )
}
