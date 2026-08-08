import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'

/**
 * A card-shaped navigation tile: a bordered, padded, hoverable surface that is a
 * single {@link Link}. The reusable replacement for bare `<li><Link></li>` list
 * items (world picker, entity lists, …). Renders its own `<li>`, so drop a set
 * of them inside a `<ul className="card-grid">` for a responsive grid of cards.
 */
export function CardLink({
  to,
  title,
  meta,
}: {
  to: string
  title: string
  meta?: ReactNode
}): React.JSX.Element {
  return (
    <li className="card-link-item">
      <Link className="card-link" to={to}>
        <span className="card-link-title">{title}</span>
        {meta === undefined ? null : <span className="card-link-meta">{meta}</span>}
      </Link>
    </li>
  )
}
