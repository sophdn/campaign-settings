import type { ButtonHTMLAttributes } from 'react'

/** Look of a button; a single union beats a scatter of `isPrimary`/`isDanger` flags. */
export type ButtonVariant = 'primary' | 'secondary' | 'danger'

/**
 * The shared action button. `variant` picks the look (primary accent by default,
 * neutral secondary, destructive danger). Every native `<button>` prop —
 * `type`, `onClick`, `disabled`, `aria-*` — spreads straight through, so it
 * drops in wherever a raw `<button>` was without changing behaviour.
 */
export function Button({
  variant = 'primary',
  className,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant }): React.JSX.Element {
  const cls = `btn btn-${variant}${className ? ` ${className}` : ''}`
  return <button className={cls} {...rest} />
}
