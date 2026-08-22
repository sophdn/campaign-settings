import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'

/**
 * A subtle "← back" affordance linking to `to`. The arrow is decorative
 * (aria-hidden), so the accessible name is just the label text.
 */
export function BackLink({ to, children }: { to: string; children: ReactNode }): React.JSX.Element {
  return (
    <Link className="back-link" to={to}>
      <span aria-hidden="true">←</span> {children}
    </Link>
  )
}
