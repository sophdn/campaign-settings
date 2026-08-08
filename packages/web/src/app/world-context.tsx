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
