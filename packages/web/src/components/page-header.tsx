import type { ReactNode } from 'react'

/**
 * A page's `<h1>` with optional right-aligned actions (a view toggle, etc.).
 * Unifies the bare `<h1>` opener and the former `.wiki-head` (h1 + control) row
 * into one baseline-aligned header.
 */
export function PageHeader({
  title,
  actions,
}: {
  title: ReactNode
  actions?: ReactNode
}): React.JSX.Element {
  return (
    <div className="page-header">
      <h1>{title}</h1>
      {actions === undefined ? null : <div className="page-header-actions">{actions}</div>}
    </div>
  )
}
