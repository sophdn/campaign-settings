import { denizensByRole, representativePopulation } from '@campaign-settings/shared'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { ApiClient, Entity } from '../api'
import { errorMessage } from '../app/error-message'
import { Button } from '../components/button'
import { Panel } from '../components/panel'

/**
 * The parametric demographics model, surfaced on a settlement.
 *
 * The engine is already ported and exhaustively unit-tested in
 * `shared/settlement-demographics`; this is the surface it never had. Both
 * figures derive from the {size, wealth, terrain} axes rather than from the
 * stored `population` column — dm-manager's rule, and the reason the population
 * field's hint says leaving it at 0 defers to the estimate. The axes are what a
 * DM actually picks; the column is an override for when they know better.
 *
 * Reads the settlement the page already loaded rather than fetching it again.
 *
 * Each role creates a blank NPC carrying that occupation and opens it, which is
 * the whole point of the census: it turns "a town this size supports four
 * smiths" into four NPCs the DM can name. Owner-only, because creating content
 * is; a player still sees the census, which is derived from columns they can
 * already read.
 */
export function SettlementDemographicsPanel({
  api,
  worldId,
  entity,
  canEdit,
}: {
  api: ApiClient
  worldId: string
  entity: Entity
  canEdit: boolean
}): React.JSX.Element | null {
  const navigate = useNavigate()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const dims = {
    size: String(entity.size ?? ''),
    wealth: String(entity.wealth ?? ''),
    terrain: String(entity.terrain ?? ''),
  }
  const population = representativePopulation(dims)
  const denizens = denizensByRole(dims)

  // Size is the driver: with no size picked there is no estimate, and a panel
  // reading "Estimated population: 0" is worse than no panel.
  if (population === 0 && denizens.length === 0) return null

  async function createDenizen(role: string): Promise<void> {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      // Named for the role, not for a generated person — the DM replaces it.
      const npc = await api.createEntity(worldId, 'npc', { name: role, occupation: role })
      await navigate(`/worlds/${worldId}/npc/${npc.id}`)
    } catch (err) {
      setError(errorMessage(err, 'Could not create that NPC'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Panel ariaLabel="Demographics">
      <h3>Demographics</h3>
      <p>
        Estimated population: <strong>{population}</strong>
      </p>
      <p className="muted">Estimated from size, wealth and terrain.</p>

      {denizens.length === 0 ? null : (
        <>
          <h4>Likely denizens</h4>
          {canEdit ? <p className="muted">Pick a role to create a blank NPC for it.</p> : null}
          <ul className="denizen-list">
            {denizens.map((d) => (
              <li key={d.role}>
                {canEdit ? (
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={busy}
                    onClick={() => void createDenizen(d.role)}
                  >
                    {d.role}
                  </Button>
                ) : (
                  <span>{d.role}</span>
                )}
                <span className="muted">×{d.count}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      {error ? <p role="alert">{error}</p> : null}
    </Panel>
  )
}
