import type { ReactNode } from 'react'

/**
 * The form-flavoured {@link Panel}: a full-width, padded card that is a `<form>`.
 * Owns the submit plumbing (preventDefault → delegate) and shares the `.panel`
 * card styling, so every form (create forms with a `title`, in-place editors
 * without one) gets full-width by default from a single place. Provide `title`
 * to show a heading (it also names the form); otherwise pass `ariaLabel`.
 */
export function FormCard({
  title,
  onSubmit,
  ariaLabel,
  children,
}: {
  title?: string
  onSubmit: () => void | Promise<void>
  ariaLabel?: string
  children: ReactNode
}): React.JSX.Element {
  return (
    <form
      className="panel form-card"
      aria-label={ariaLabel ?? title}
      onSubmit={(e) => {
        e.preventDefault()
        void onSubmit()
      }}
    >
      {title ? <h2 className="form-card-title">{title}</h2> : null}
      {children}
    </form>
  )
}
