import { ENTITY_TIERS, kindsByTier } from '@campaign-settings/shared'
import { useCallback, useEffect, useState } from 'react'
import { Link, Outlet, useLocation, useParams } from 'react-router-dom'
import { Loading } from '../components/status'
import { TierSection } from '../components/tier-section'
import { useApi } from './api-context'
import { Modal } from './modal/modal'
import { useResource } from './use-resource'
import { isOwnerRole, WorldRoleProvider } from './world-context'

/**
 * The world's sections, as one list.
 *
 * ONE component, rendered twice: as the rail in its own grid column above the
 * breakpoint, and as the contents of the drawer below it. Two copies of this
 * list is how a link ends up reachable on a desktop and missing on a phone.
 */
function WorldNav({
  base,
  worldName,
  isOwner,
  className,
}: {
  base: string
  worldName: string
  isOwner: boolean
  className: string
}): React.JSX.Element {
  const byTier = kindsByTier()
  return (
    <nav className={className} aria-label="World sections">
      {/* Which world you are in was legible only from the URL slug, which
          is derived from the name and not always the same as it. */}
      <strong className="world-nav-title">{worldName}</strong>
      {/* The world root is the dashboard now; the wiki index moved to its
          own path. Both get a link, because the wiki is still where you go
          to browse everything and the dashboard deliberately does not list
          it all. */}
      <Link to={base}>Dashboard</Link>
      <Link to={`${base}/wiki`}>Wiki</Link>
      {ENTITY_TIERS.map((tier) => (
        <TierSection key={tier} tier={tier} base={base} kinds={byTier[tier]} />
      ))}
      {/* Maps used to be hardcoded here, beside the wiki, because the `map`
          registry entry was `nav: false`. It is now `nav: true` and sits in
          the Primary tier above — ONE kinds array feeding both this rail and
          the dashboard's quick links. Notes, Suggestions and Members stay
          hardcoded: they are surfaces, not entity kinds. */}
      <Link to={`${base}/notes`}>Notes</Link>
      <Link to={`${base}/suggestions`}>Suggestions</Link>
      <Link to={`${base}/members`}>Members</Link>
      {/* Owner-only, because renaming is all it holds today and a player
          cannot do it. Presentation, not the gate — the route and the
          endpoint both stand on their own. */}
      {/* Trash is owner-only for the same reason Settings is: a player
          has nothing to do there, and the server refuses all three of its
          calls regardless of what this renders. */}
      {isOwner ? (
        <>
          <Link to={`${base}/trash`}>Trash</Link>
          <Link to={`${base}/settings`}>Settings</Link>
        </>
      ) : null}
      <Link to="/">← Worlds</Link>
    </nav>
  )
}

/**
 * Chrome for a single world: resolves the viewer's role, then the nav + screen.
 *
 * ## The nav on a phone
 *
 * The rail used to STACK below 600px, which put a full-height list of links
 * above every screen — tapping an entity kind looked like it did nothing until
 * you scrolled past the nav. The fix at the time was to narrow the rail
 * instead, which left a permanently-visible column stealing width from the
 * content on exactly the screens with least of it.
 *
 * Below the breakpoint the rail is hidden entirely and a hamburger opens it as
 * a full-page drawer entering from the right. Above it, nothing changes: the
 * rail keeps its own grid column.
 *
 * ## Why the shared Modal, and why the component rather than the service
 *
 * The focus trap, the scrim, Escape and the scroll lock are dialog mechanics
 * rather than drawer mechanics, and a hand-rolled second copy is a second place
 * for them to be subtly wrong.
 *
 * It is the `Modal` COMPONENT rather than the imperative `useModal` service
 * because the hamburger has to report its own expanded state. The service
 * exposes no "is this particular thing open" — and Escape closes a modal
 * without telling whoever opened it, so a boolean kept beside the service would
 * go stale the first time someone pressed it.
 *
 * The hamburger sits top-LEFT even though the drawer opens from the right,
 * which is the conventional pairing.
 */
export function WorldLayout(): React.JSX.Element {
  const api = useApi()
  const { worldId = '' } = useParams()
  const fetcher = useCallback(() => api.getWorld(worldId), [api, worldId])
  const { data: world, loading, error, reload } = useResource(fetcher)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const { pathname } = useLocation()
  const base = `/worlds/${worldId}`

  // Closed on navigation, so tapping a kind does not leave the drawer covering
  // the page it just opened. Keyed on the PATH rather than on each link's own
  // click handler: a link inside the collapsible tiers would otherwise need one
  // too, and a link added later would be missed.
  useEffect(() => setDrawerOpen(false), [pathname])

  if (loading) return <Loading />
  if (error || !world) return <p role="alert">{error ?? 'World not found'}</p>

  const isOwner = isOwnerRole(world.role)
  const nav = (className: string): React.JSX.Element => (
    <WorldNav className={className} base={base} worldName={world.name} isOwner={isOwner} />
  )

  return (
    <WorldRoleProvider
      value={{ worldId, worldName: world.name, role: world.role, refreshWorld: reload }}
    >
      <div className="world">
        {/* Rendered at every width and HIDDEN above the breakpoint by CSS,
            rather than mounted conditionally on a measured width: a JS
            breakpoint would disagree with the stylesheet's the moment one of
            them changed, and this way there is one number in one place. */}
        <button
          type="button"
          className="world-nav-toggle"
          aria-expanded={drawerOpen}
          aria-label="World sections"
          onClick={() => setDrawerOpen(true)}
        >
          <span aria-hidden="true">☰</span>
        </button>
        {nav('world-nav')}
        <div className="world-content">
          <Outlet />
        </div>
        {drawerOpen ? (
          <Modal
            onClose={() => setDrawerOpen(false)}
            ariaLabel="World sections"
            className="modal-drawer"
          >
            {nav('world-nav world-nav-drawer')}
          </Modal>
        ) : null}
      </div>
    </WorldRoleProvider>
  )
}
