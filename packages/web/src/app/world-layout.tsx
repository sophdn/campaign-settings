import { ENTITY_TIERS, navKindsByTier } from '@campaign-settings/shared'
import { useCallback } from 'react'
import { Link, Outlet, useParams } from 'react-router-dom'
import { Loading } from '../components/status'
import { TierSection } from '../components/tier-section'
import { useApi } from './api-context'
import { useResource } from './use-resource'
import { WorldRoleProvider } from './world-context'

/** Chrome for a single world: resolves the viewer's role, then the nav + screen. */
export function WorldLayout(): React.JSX.Element {
  const api = useApi()
  const { worldId = '' } = useParams()
  const fetcher = useCallback(() => api.getWorld(worldId), [api, worldId])
  const { data: world, loading, error, reload } = useResource(fetcher)
  const base = `/worlds/${worldId}`

  if (loading) return <Loading />
  if (error || !world) return <p role="alert">{error ?? 'World not found'}</p>

  const byTier = navKindsByTier()

  return (
    <WorldRoleProvider
      value={{ worldId, worldName: world.name, role: world.role, refreshWorld: reload }}
    >
      <div className="world">
        <nav className="world-nav" aria-label="World sections">
          {/* Which world you are in was legible only from the URL slug, which
              is derived from the name and not always the same as it. */}
          <strong className="world-nav-title">{world.name}</strong>
          <Link to={base}>Wiki</Link>
          {ENTITY_TIERS.map((tier) => (
            <TierSection key={tier} tier={tier} base={base} kinds={byTier[tier]} />
          ))}
          {/* Maps sit beside the wiki rather than inside a kind tier: they are
              world-level assets with their own index, and the `map` registry
              entry is `nav: false` precisely because it is not an entity list. */}
          <Link to={`${base}/maps`}>Maps</Link>
          <Link to={`${base}/notes`}>Notes</Link>
          <Link to={`${base}/suggestions`}>Suggestions</Link>
          <Link to={`${base}/members`}>Members</Link>
          {/* Owner-only, because renaming is all it holds today and a player
              cannot do it. Presentation, not the gate — the route and the
              endpoint both stand on their own. */}
          {/* Trash is owner-only for the same reason Settings is: a player
              has nothing to do there, and the server refuses all three of its
              calls regardless of what this renders. */}
          {world.role === 'owner' ? (
            <>
              <Link to={`${base}/trash`}>Trash</Link>
              <Link to={`${base}/settings`}>Settings</Link>
            </>
          ) : null}
          <Link to="/">← Worlds</Link>
        </nav>
        <div className="world-content">
          <Outlet />
        </div>
      </div>
    </WorldRoleProvider>
  )
}
