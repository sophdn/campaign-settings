import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ModalProvider, useModal } from './modal-context'

function Harness(): React.JSX.Element {
  const { open, close } = useModal()
  return (
    <div>
      <button onClick={() => open(<p>hello modal</p>, { ariaLabel: 'greeting' })}>open</button>
      <button onClick={() => open(<p>locked</p>, { dismissible: false, labelledBy: 'x' })}>
        open-locked
      </button>
      <button onClick={close}>close</button>
    </div>
  )
}

function renderHarness() {
  return render(
    <ModalProvider>
      <Harness />
    </ModalProvider>,
  )
}

describe('ModalProvider / useModal', () => {
  it('opens content on demand and closes it (dismissible by default)', () => {
    renderHarness()
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'open' }))
    const dialog = screen.getByRole('dialog', { name: 'greeting' })
    expect(dialog.textContent).toContain('hello modal')
    fireEvent.keyDown(dialog, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('forwards options: non-dismissible + aria-labelledby, closed only via the service', () => {
    renderHarness()
    fireEvent.click(screen.getByRole('button', { name: 'open-locked' }))
    const dialog = screen.getByRole('dialog')
    expect(dialog.getAttribute('aria-labelledby')).toBe('x')
    // non-dismissible: Escape does not close it
    fireEvent.keyDown(dialog, { key: 'Escape' })
    expect(screen.getByRole('dialog')).toBeTruthy()
    // the service's close() still works
    fireEvent.click(screen.getByRole('button', { name: 'close' }))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('throws when useModal is used outside a ModalProvider', () => {
    function Orphan(): React.JSX.Element {
      useModal()
      return <div />
    }
    expect(() => render(<Orphan />)).toThrow('useModal must be used within a ModalProvider')
  })
})
