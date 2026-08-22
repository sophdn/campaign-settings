import type { ReactNode } from 'react'

/**
 * A small pill chip — entity kind, interaction type, link type, status. The
 * neutral look lives in the `.badge` rule; `color` tints just the label (kind
 * chips pass a `var(--color-*)` from kindColor). `className` lets a caller keep
 * a legacy hook class (`.wiki-kind` / `.touch-type` / `.link-type`) riding along.
 */
export function Badge({
  children,
  color,
  className,
}: {
  children: ReactNode
  color?: string
  className?: string
}): React.JSX.Element {
  return (
    <span
      className={className ? `badge ${className}` : 'badge'}
      style={color === undefined ? undefined : { color }}
    >
      {children}
    </span>
  )
}
