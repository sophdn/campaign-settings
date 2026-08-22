import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { Modal } from './modal'

describe('Modal', () => {
  it('renders an accessible dialog in a portal and labels it via aria-label', () => {
    render(
      <Modal onClose={() => {}} ariaLabel="greeting">
        <button>inside</button>
      </Modal>,
    )
    const dialog = screen.getByRole('dialog', { name: 'greeting' })
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    // portalled onto document.body, not nested in the render container
    expect(dialog.closest('.modal-overlay')?.parentElement).toBe(document.body)
  })

  it('labels the dialog via aria-labelledby when provided', () => {
    render(
      <Modal onClose={() => {}} labelledBy="t">
        <h2 id="t">Title</h2>
      </Modal>,
    )
    expect(screen.getByRole('dialog').getAttribute('aria-labelledby')).toBe('t')
  })

  it('omits labelling attributes when neither is given', () => {
    render(
      <Modal onClose={() => {}}>
        <button>x</button>
      </Modal>,
    )
    const dialog = screen.getByRole('dialog')
    expect(dialog.hasAttribute('aria-label')).toBe(false)
    expect(dialog.hasAttribute('aria-labelledby')).toBe(false)
  })

  it('moves focus to the first focusable on open', () => {
    render(
      <Modal onClose={() => {}} ariaLabel="m">
        <button>one</button>
        <button>two</button>
      </Modal>,
    )
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'one' }))
  })

  it('focuses the dialog itself when it has no focusable content', () => {
    render(
      <Modal onClose={() => {}} ariaLabel="m">
        <span>just text</span>
      </Modal>,
    )
    const dialog = screen.getByRole('dialog')
    expect(document.activeElement).toBe(dialog)
    // Tab is trapped: focus stays on the dialog
    fireEvent.keyDown(dialog, { key: 'Tab' })
    expect(document.activeElement).toBe(dialog)
  })

  it('wraps Tab focus at the dialog edges', () => {
    render(
      <Modal onClose={() => {}} ariaLabel="m">
        <button>one</button>
        <button>two</button>
      </Modal>,
    )
    const one = screen.getByRole('button', { name: 'one' })
    const two = screen.getByRole('button', { name: 'two' })
    const dialog = screen.getByRole('dialog')
    two.focus()
    fireEvent.keyDown(dialog, { key: 'Tab' })
    expect(document.activeElement).toBe(one)
    one.focus()
    fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(two)
  })

  it('does not move focus when tabbing from a non-edge position', () => {
    render(
      <Modal onClose={() => {}} ariaLabel="m">
        <button>one</button>
        <button>two</button>
      </Modal>,
    )
    const one = screen.getByRole('button', { name: 'one' })
    one.focus()
    // forward Tab from the first (non-last) element: no wrap, focus unchanged
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Tab' })
    expect(document.activeElement).toBe(one)
  })

  it('ignores keys other than Tab and Escape', () => {
    const onClose = vi.fn()
    render(
      <Modal onClose={onClose} ariaLabel="m">
        <button>one</button>
      </Modal>,
    )
    const one = screen.getByRole('button', { name: 'one' })
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'a' })
    expect(onClose).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(one)
  })

  it('closes on Escape only when dismissible', () => {
    const onClose = vi.fn()
    const { rerender } = render(
      <Modal onClose={onClose} ariaLabel="m">
        <button>x</button>
      </Modal>,
    )
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
    rerender(
      <Modal onClose={onClose} dismissible={false} ariaLabel="m">
        <button>x</button>
      </Modal>,
    )
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1) // unchanged
  })

  it('closes on an overlay click but not a click inside the dialog', () => {
    const onClose = vi.fn()
    render(
      <Modal onClose={onClose} ariaLabel="m">
        <button>inside</button>
      </Modal>,
    )
    const overlay = screen.getByRole('dialog').parentElement as HTMLElement
    fireEvent.mouseDown(screen.getByRole('button', { name: 'inside' }))
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.mouseDown(overlay)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('does not dismiss on an overlay click when not dismissible', () => {
    const onClose = vi.fn()
    render(
      <Modal onClose={onClose} dismissible={false} ariaLabel="m">
        <button>inside</button>
      </Modal>,
    )
    fireEvent.mouseDown(screen.getByRole('dialog').parentElement as HTMLElement)
    expect(onClose).not.toHaveBeenCalled()
  })

  it('locks body scroll while open and restores it on close', () => {
    document.body.style.overflow = 'scroll'
    const { unmount } = render(
      <Modal onClose={() => {}} ariaLabel="m">
        <button>x</button>
      </Modal>,
    )
    expect(document.body.style.overflow).toBe('hidden')
    unmount()
    expect(document.body.style.overflow).toBe('scroll')
  })

  it('restores focus to the opener on close', () => {
    const opener = document.createElement('button')
    document.body.appendChild(opener)
    opener.focus()
    const { unmount } = render(
      <Modal onClose={() => {}} ariaLabel="m">
        <button>x</button>
      </Modal>,
    )
    expect(document.activeElement).not.toBe(opener)
    unmount()
    expect(document.activeElement).toBe(opener)
    opener.remove()
  })
})
