import { kindIndexPath, primaryKinds } from '@campaign-settings/shared'
import { useCallback } from 'react'
import { Link, useParams } from 'react-router-dom'
import type { DashboardTouch, PartyMember, WorldDashboard } from '../api'
import { useApi } from '../app/api-context'
import { useResource } from '../app/use-resource'
import { useIsOwner, useWorld } from '../app/world-context'
import { Badge } from '../components/badge'
import { PageHeader } from '../components/page-header'
import { Panel } from '../components/panel'
import { ResourceView } from '../components/resource-view'
import { EmptyState } from '../components/status'
import { kindColor, kindLabel } from './kind-color'

/**
 * The world root: what a viewer sees on arrival, before they go looking.
 *
 * ## Why the two roles order the screen differently
 *
 * A GM sees the session first, then the party: they arrive to keep writing. A
 * player sees their character first, then the session: they arrive to find
 * themselves. Same components, different priority — which is a second, quieter
 * role signal that costs no chrome.
 *
 * That matters more than it looks. Chain 470 task 3 DROPPED the persistent role
 * badge on the argument that this screen carries the signal instead, so reading
 * differently for the two roles is load-bearing here, not decoration. The
 * role sentence at the top is the explicit half of the same job: it states what
 * you can do rather than naming you, because "Player" alone does not tell a
 * newcomer that their notes are private and their additions are suggestions.
 */

/** Which session-ordering rule put the row on the panel, said plainly. */
const ORDERING_NOTE = {
  played_at: 'most recent in-world date',
  updated_at: 'most recently edited',
} as const

/**
 * The role sentence — the explicit half of the role signal.
 *
 * Sourced from the owner-capability audit (chain 470 task 2, recorded at
 * vault/decisions/2026-08-19_campaign-settings-owner-only-capabilities.md): a
 * player's own two things are their notes, which the GM can read but not write,
 * and proposing a reveal.
 */
function RoleStatement({ isOwner }: { isOwner: boolean }): React.JSX.Element {
  return (
    <Panel ariaLabel="Your role">
      {isOwner ? (
        <p className="role-statement">
          You are the <strong>GM</strong>. You write this world — everyone else reads it, keeps
          private notes, and suggests additions.
        </p>
      ) : (
        <p className="role-statement">
          You are a <strong>player</strong>. You read this world, keep notes only you can write, and
          suggest additions for the GM to accept.
        </p>
      )}
    </Panel>
  )
}

/** One touched entity, as a link into its page. */
function TouchLink({ touch, base }: { touch: DashboardTouch; base: string }): React.JSX.Element {
  return (
    <Link className="touch-chip" to={`${base}/${touch.entityKind}/${touch.entityId}`}>
      <Badge className="touch-type" color={kindColor(touch.entityKind)}>
        {kindLabel(touch.entityKind)}
      </Badge>
      <span>{touch.entityName}</span>
    </Link>
  )
}

/**
 * The session panel.
 *
 * Deliberately NOT headed "Last session". The ordering falls back to
 * `updated_at`, so editing an old undated session promotes it — "last session"
 * would become a lie the first time that happened. The heading names
 * work-recency, the grey note beside it says which rule placed the row, and the
 * date line says whether the session has a story date at all.
 */
function SessionPanel({
  dashboard,
  base,
  isOwner,
}: {
  dashboard: WorldDashboard
  base: string
  isOwner: boolean
}): React.JSX.Element {
  const { session } = dashboard
  if (!session) {
    return (
      <Panel ariaLabel="Where you left off">
        <h2>Where you left off</h2>
        <EmptyState>No sessions written up yet.</EmptyState>
        <p>Once you record a session, this is where it lands, along with everyone it involved.</p>
        {isOwner ? <Link to={`${base}/session`}>Write up a session</Link> : null}
      </Panel>
    )
  }

  // "Met" versus everything else. The raw vocabulary (met/affected/killed/
  // discussed/other) is the GM's authoring detail; on arrival the useful split
  // is who the party actually met and who else was in the scene.
  const met = session.touches.filter((t) => t.touchType === 'met')
  const involved = session.touches.filter((t) => t.touchType !== 'met')

  return (
    <Panel ariaLabel="Where you left off">
      <div className="panel-head">
        <h2>Where you left off</h2>
        <span className="panel-note">{ORDERING_NOTE[session.ordering]}</span>
      </div>
      <h3>
        <Link to={`${base}/session/${session.id}`}>{session.name}</Link>
      </h3>
      <p className="session-date">
        {session.playedAt === null ? (
          <>
            <span className="empty-state">no in-world date</span>
            {isOwner ? <Link to={`${base}/session/${session.id}`}>Set one</Link> : null}
          </>
        ) : (
          session.playedAt
        )}
      </p>
      {session.capturedText === '' ? null : (
        <p className="session-excerpt">{session.capturedText}</p>
      )}
      {met.length > 0 ? (
        <div className="touch-group">
          <h4>Met</h4>
          <div className="touch-chips">
            {met.map((t) => (
              <TouchLink key={t.id} touch={t} base={base} />
            ))}
          </div>
        </div>
      ) : null}
      {involved.length > 0 ? (
        <div className="touch-group">
          <h4>Also involved</h4>
          <div className="touch-chips">
            {involved.map((t) => (
              <TouchLink key={t.id} touch={t} base={base} />
            ))}
          </div>
        </div>
      ) : null}
    </Panel>
  )
}

/** The GM's party: every PC in the world, and who plays it. */
function PartyPanel({ party, base }: { party: PartyMember[]; base: string }): React.JSX.Element {
  return (
    <Panel ariaLabel="The party">
      <h2>The party</h2>
      {party.length === 0 ? (
        <EmptyState>No characters yet.</EmptyState>
      ) : (
        <ul className="party-list">
          {party.map((pc) => (
            <li key={pc.id}>
              <Link to={`${base}/pc/${pc.id}`}>{pc.name}</Link>
              <span className={pc.playerName === null ? 'empty-state' : 'party-player'}>
                {pc.playerName === null ? 'No player linked' : pc.playerName}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  )
}

/** The player's own character, resolved through the account link. */
function MyCharacterPanel({
  dashboard,
  base,
}: {
  dashboard: WorldDashboard
  base: string
}): React.JSX.Element {
  const pc = dashboard.myCharacter
  return (
    <Panel ariaLabel="Your character">
      <h2>Your character</h2>
      {pc === null ? (
        <>
          <EmptyState>No character linked to you yet.</EmptyState>
          <p>
            Your GM links a character to your account. Until then, you can still read the world,
            keep notes, and suggest additions.
          </p>
        </>
      ) : (
        <p className="my-character">
          <Link to={`${base}/pc/${pc.id}`}>{pc.name}</Link>
          <span className="party-player">Played by you</span>
        </p>
      )}
    </Panel>
  )
}

/**
 * Quick links to the Primary kinds, with a live count each.
 *
 * The kinds come from `primaryKinds()` — the same array the rail's Primary
 * section reads, which is why Maps appears in both places or neither. The
 * counts are the viewer's own: a player's numbers are smaller than the GM's for
 * the same world, and that is the visibility model showing through the ordinary
 * authorization-filtered reads rather than a second code path.
 */
function JumpToPanel({
  counts,
  base,
}: {
  counts: Record<string, number>
  base: string
}): React.JSX.Element {
  return (
    <Panel ariaLabel="Jump to">
      <h2>Jump to</h2>
      <ul className="jump-links">
        {primaryKinds().map((k) => (
          <li key={k.kind}>
            <Link to={`${base}/${kindIndexPath(k.kind)}`}>
              <span>{k.label.plural}</span>
              <span className="jump-count">{counts[k.kind] ?? 0}</span>
            </Link>
          </li>
        ))}
      </ul>
    </Panel>
  )
}

/** The world root screen. */
export function WorldDashboardPage(): React.JSX.Element {
  const api = useApi()
  const { worldId = '' } = useParams()
  const { worldName } = useWorld()
  const isOwner = useIsOwner()
  const fetcher = useCallback(() => api.getDashboard(worldId), [api, worldId])
  const dashboardRes = useResource(fetcher)
  const base = `/worlds/${worldId}`

  return (
    <section className="dashboard">
      <PageHeader title={worldName} />
      <RoleStatement isOwner={isOwner} />
      <ResourceView resource={dashboardRes}>
        {(dashboard) => (
          <>
            {isOwner ? (
              <>
                <SessionPanel dashboard={dashboard} base={base} isOwner={isOwner} />
                <PartyPanel party={dashboard.party} base={base} />
              </>
            ) : (
              <>
                <MyCharacterPanel dashboard={dashboard} base={base} />
                <SessionPanel dashboard={dashboard} base={base} isOwner={isOwner} />
              </>
            )}
            <JumpToPanel counts={dashboard.counts} base={base} />
          </>
        )}
      </ResourceView>
    </section>
  )
}
