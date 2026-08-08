import { type EntityTier, TIER_TITLES } from '@campaign-settings/shared'
import { Link } from 'react-router-dom'

/**
 * One collapsible tier of entity-kind links in the world nav rail. Rendered once
 * per tier (primary/secondary/tertiary) — this is THE single dropdown component,
 * not three near-duplicates. Primary is open by default; the links sit inside a
 * wrapper that draws the indenting left rule.
 */
export function TierSection({
  tier,
  base,
  kinds,
}: {
  tier: EntityTier
  base: string
  kinds: { kind: string; label: { plural: string } }[]
}): React.JSX.Element {
  return (
    <details className="nav-tier" open={tier === 'primary'}>
      <summary>{TIER_TITLES[tier]}</summary>
      <div className="nav-tier-links">
        {kinds.map((k) => (
          <Link key={k.kind} to={`${base}/${k.kind}`}>
            {k.label.plural}
          </Link>
        ))}
      </div>
    </details>
  )
}
