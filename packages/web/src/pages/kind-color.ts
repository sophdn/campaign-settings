import { findKindEntry } from '@campaign-settings/shared'

/** Map an entity kind's registry badge colour to its CSS custom property. */
const BADGE_VARS: Record<string, string> = {
  accent: 'var(--color-accent)',
  danger: 'var(--color-danger)',
  success: 'var(--color-success)',
  warning: 'var(--color-warning)',
  textSecondary: 'var(--color-text-secondary)',
}

/** The themed colour for a kind's badge/graph-node (defaults to the text colour). */
export function kindColor(kind: string): string {
  const badge = findKindEntry(kind)?.badgeColor
  return (badge && BADGE_VARS[badge]) ?? 'var(--color-text-secondary)'
}

/** The human-facing singular label for a kind (falls back to the raw kind). */
export function kindLabel(kind: string): string {
  return findKindEntry(kind)?.label.singular ?? kind
}
