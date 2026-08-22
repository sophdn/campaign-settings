import { createContext, useContext } from 'react'
import type { MemberRole } from '../api'

/** The current world + the viewer's role in it, provided by WorldLayout. */
export interface WorldRole {
  /** The world's slug — the URL key every world-scoped call is addressed by. */
  worldId: string
  /** The world's display name, for chrome that has to say which world this is. */
  worldName: string
  role: MemberRole
  /**
   * Re-read the world from the server. Neither half of it is immutable for the
   * life of the route: accepting an ownership transfer changes the ROLE under
   * the page (without this the SPA would keep rendering the player view for
   * someone who is now the GM), and renaming changes the NAME.
   */
  refreshWorld: () => void
}

const WorldContext = createContext<WorldRole | null>(null)

export const WorldRoleProvider = WorldContext.Provider

export function useWorld(): WorldRole {
  const ctx = useContext(WorldContext)
  if (!ctx) throw new Error('useWorld must be used within a world route')
  return ctx
}

/**
 * THE presentation rule for owner-only affordances, stated once and derived
 * once (`useIsOwner` below reads it from the world context; `isOwnerRole` is
 * the same predicate for the one component that has the role in hand before
 * the context exists, WorldLayout):
 *
 * An affordance the viewer's ROLE can never use is not rendered at all — no
 * disabled control, no teaser, no CTA. A player is not a prospective GM in
 * this world (role changes only through an accepted ownership transfer), so
 * a control they can never press is noise rather than information.
 *
 * The one exception to "not rendered at all" is a directly-addressable
 * ROUTE: a player can always type /settings into the bar, so an owner-only
 * route renders a plain statement of the rule plus whatever of it is
 * readable (world-settings-page.tsx), rather than a dead end.
 *
 * An affordance the viewer's role CAN use, but which this DEPLOYMENT has
 * switched off (a feature flag) or capped (demo read-only), renders normally
 * and routes to the contact modal when used — that half of the rule lives in
 * `useSurfaceGate` (surface-gate.ts). The portfolio demo is an instance of
 * both halves, not a special case: a demo visitor holds the player role, so
 * this half hides the owner-only surfaces, and the player-legal writes demo
 * mode refuses are caught by the other.
 *
 * Neither half is the gate. Every owner-only capability is enforced
 * server-side (enumerated in vault decision
 * 2026-08-19_campaign-settings-owner-only-capabilities); this predicate only
 * reflects role and must never become a second place role is decided.
 */
export function isOwnerRole(role: MemberRole): boolean {
  return role === 'owner'
}

/** The viewer's side of the rule above, read from the world context. */
export function useIsOwner(): boolean {
  return isOwnerRole(useWorld().role)
}
