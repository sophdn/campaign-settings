/**
 * Per-entity visibility — the 3-state model that replaces the old `dm_only`
 * boolean. A content row is visible to a player iff it is `public`, or it is
 * `restricted` AND that player holds a grant (see the entity_visibility ACL).
 * `dm_only` is owner-only. The authorization seam is the single enforcer.
 */
export type Visibility = 'public' | 'dm_only' | 'restricted'

export const VISIBILITIES: readonly Visibility[] = ['public', 'dm_only', 'restricted']

/**
 * Map dm-manager's boolean `dm_only` (the import boundary) to a visibility.
 * A missing/undefined flag is treated as `public` (the column's old default).
 */
export function visibilityFromDmOnly(dmOnly: boolean | undefined): Visibility {
  return dmOnly ? 'dm_only' : 'public'
}
