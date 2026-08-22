import { type ReactNode, useCallback, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'

/** Elements that can hold keyboard focus — for initial focus and the trap. */
const FOCUSABLE =
  'a[href],area[href],input:not([disabled]),select:not([disabled]),' +
  'textarea:not([disabled]),button:not([disabled]),[tabindex]:not([tabindex="-1"])'

export interface ModalProps {
  children: ReactNode
  onClose: () => void
  /** When false, Escape and overlay clicks do NOT close — the caller drives it. */
  dismissible?: boolean
  /** id of the element that titles the dialog (preferred over a literal label). */
  labelledBy?: string
  /** Literal accessible name, when there is no visible title element. */
  ariaLabel?: string
  /**
   * Extra class on the dialog surface, for content whose shape the default box
   * does not fit — an image viewer wants the width of the viewport, a
   * confirmation wants a column of text. Layout only: the mechanics above
   * (focus trap, scrim, Escape, scroll lock) are the same either way, which is
   * the whole reason a second modal implementation is not the answer.
   */
  className?: string
}

/**
 * A generalized, accessible modal dialog rendered in a portal on `document.body`.
 * Content-agnostic: it knows nothing about what it shows. It owns the dialog
 * mechanics once — focus trap, initial focus and restore, Escape and overlay-click
 * dismissal, scroll lock, and ARIA — so features (contact, cookie preferences,
 * confirmations) supply only their content.
 */
export function Modal({
  children,
  onClose,
  dismissible = true,
  labelledBy,
  ariaLabel,
  className,
}: ModalProps): React.JSX.Element {
  // Defaults to <body> so restore is always a valid focus target (activeElement
  // is never null in a live document — the cast just drops the nominal null).
  const openerRef = useRef<HTMLElement>(document.body)

  // Ref callback (runs in the commit phase, before any effect): on mount, capture
  // the opener BEFORE stealing focus, then move focus to the first focusable inside
  // (or the dialog itself); on unmount, restore focus to the opener.
  const attach = useCallback((node: HTMLDivElement | null) => {
    if (node) {
      openerRef.current = document.activeElement as HTMLElement
      const first = node.querySelector<HTMLElement>(FOCUSABLE)
      ;(first ?? node).focus()
      return
    }
    openerRef.current.focus()
  }, [])

  // Lock body scroll while the modal is open; restore the prior value on close.
  useEffect(() => {
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = previous
    }
  }, [])

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Escape') {
      if (dismissible) onClose()
      return
    }
    if (e.key !== 'Tab') return
    const items = Array.from(e.currentTarget.querySelectorAll<HTMLElement>(FOCUSABLE))
    if (items.length === 0) {
      // nothing to tab to — keep focus on the dialog rather than escaping it
      e.preventDefault()
      e.currentTarget.focus()
      return
    }
    const first = items[0]!
    const last = items[items.length - 1]!
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault()
      first.focus()
    }
  }

  return createPortal(
    <div
      className="modal-overlay"
      onMouseDown={(e) => {
        // Only a click on the scrim itself (not a bubble from inside) dismisses.
        if (dismissible && e.target === e.currentTarget) onClose()
      }}
    >
      <div
        className={className ? `modal-dialog ${className}` : 'modal-dialog'}
        role="dialog"
        aria-modal="true"
        {...(labelledBy
          ? { 'aria-labelledby': labelledBy }
          : ariaLabel
            ? { 'aria-label': ariaLabel }
            : {})}
        ref={attach}
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        {children}
      </div>
    </div>,
    document.body,
  )
}
