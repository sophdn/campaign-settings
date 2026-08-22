import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { kindColor, kindLabel } from '../pages/kind-color'
import { Badge } from './badge'

/**
 * One entity in an inline reference list: an arrow, the name, its kind, a rule
 * underneath.
 *
 * ## Why a row and not a card
 *
 * A browse grid and a reference list want different things. The wiki index is a
 * grid of cards because you are choosing among many, and a card gives each one
 * presence. A list of what this page happens to link to is read in passing —
 * you scan it for a name and leave. Cards there spend a whole tile of furniture
 * on four words, and eight of them push everything below off the screen.
 *
 * Deliberately partway between the card and plain text: the arrow says the row
 * goes somewhere, the kind tag says what you would land on, and the rule says
 * where one row ends. That is the whole vocabulary. The wiki index keeps its
 * cards.
 *
 * `leading` and `trailing` let a caller add its own marks without a second row
 * component — a relationship puts its type in `leading` and its Remove control
 * in `trailing`, which is what makes the relationship list and the mention list
 * read as siblings rather than as two unrelated designs.
 */
export function EntityRow({
  to,
  name,
  kind,
  leading,
  trailing,
}: {
  to: string
  name: string
  kind: string
  /** Rendered before the arrow — a relationship's type badge. */
  leading?: ReactNode
  /** Rendered after the kind tag — a note, a qualifier, a Remove control. */
  trailing?: ReactNode
}): React.JSX.Element {
  return (
    <li className="entity-row">
      {leading ?? null}
      {/* Decorative: the link beside it already says the row goes somewhere,
          and a screen reader announcing "right arrow" before every name is
          noise rather than information. */}
      <span className="entity-row-arrow" aria-hidden="true">
        →
      </span>
      <Link className="entity-row-name" to={to}>
        {name}
      </Link>
      <Badge className="wiki-kind" color={kindColor(kind)}>
        {kindLabel(kind)}
      </Badge>
      {trailing ?? null}
    </li>
  )
}
