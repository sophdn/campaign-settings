import { type ReactNode, createContext, useCallback, useContext, useMemo, useState } from 'react'
import { Modal } from './modal'

/** Per-open options forwarded to the {@link Modal}. */
export interface ModalOptions {
  /** When false, Escape and overlay clicks do not close it (default true). */
  dismissible?: boolean
  labelledBy?: string
  ariaLabel?: string
  /** Extra class on the dialog surface — layout only. See {@link Modal}. */
  className?: string
}

/** The imperative modal service any feature opens with its own content. */
export interface ModalService {
  open: (content: ReactNode, options?: ModalOptions) => void
  close: () => void
}

interface ModalEntry {
  content: ReactNode
  options: ModalOptions
}

const ModalContext = createContext<ModalService | null>(null)

/**
 * Holds the single active modal and exposes {@link useModal}. Renders the shared
 * {@link Modal} when something is open; content-agnostic, so it is mounted once
 * near the app root and reused for contact, cookie preferences, confirmations,
 * and whatever else.
 */
export function ModalProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [entry, setEntry] = useState<ModalEntry | null>(null)
  const close = useCallback(() => setEntry(null), [])
  const open = useCallback(
    (content: ReactNode, options: ModalOptions = {}) => setEntry({ content, options }),
    [],
  )
  const service = useMemo<ModalService>(() => ({ open, close }), [open, close])

  return (
    <ModalContext.Provider value={service}>
      {children}
      {entry ? (
        <Modal
          onClose={close}
          dismissible={entry.options.dismissible ?? true}
          {...(entry.options.labelledBy ? { labelledBy: entry.options.labelledBy } : {})}
          {...(entry.options.ariaLabel ? { ariaLabel: entry.options.ariaLabel } : {})}
          {...(entry.options.className ? { className: entry.options.className } : {})}
        >
          {entry.content}
        </Modal>
      ) : null}
    </ModalContext.Provider>
  )
}

export function useModal(): ModalService {
  const ctx = useContext(ModalContext)
  if (!ctx) throw new Error('useModal must be used within a ModalProvider')
  return ctx
}
