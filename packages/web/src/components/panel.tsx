import type { ReactNode } from 'react'

/**
 * THE shared content panel: a full-width, padded card. Read views (entity /
 * session bodies, etc.) wrap their content in this so they get the same
 * full-width treatment as the forms by default — the styling lives once in the
 * `.panel` rule, and {@link FormCard} is the form-flavoured sibling.
 */
export function Panel({
  children,
  ariaLabel,
}: {
  children: ReactNode
  ariaLabel?: string
}): React.JSX.Element {
  return (
    <section className="panel" aria-label={ariaLabel}>
      {children}
    </section>
  )
}
