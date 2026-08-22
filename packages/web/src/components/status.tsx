import type { ReactNode } from 'react'

/**
 * The shared line-level status primitives. One place owns the loading copy, the
 * `role="alert"` error line, and the muted empty-state line, so pages stop
 * hand-rolling `<p role="status">Loading…</p>` / `<p role="alert">` / `<p>No …</p>`.
 */

/** The standard loading line (polite live region). */
export function Loading(): React.JSX.Element {
  return <p role="status">Loading…</p>
}

/**
 * Assertive error line. Renders nothing for an empty message, so a caller can
 * collapse `{error ? <p role="alert">{error}</p> : null}` to `<ErrorText>{error}</ErrorText>`.
 */
export function ErrorText({ children }: { children?: ReactNode }): React.JSX.Element | null {
  if (children === null || children === undefined || children === false || children === '') {
    return null
  }
  return <p role="alert">{children}</p>
}

/** Muted empty-state line ("No X yet."). */
export function EmptyState({ children }: { children: ReactNode }): React.JSX.Element {
  return <p className="empty-state">{children}</p>
}
