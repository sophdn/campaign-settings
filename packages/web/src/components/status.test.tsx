import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { EmptyState, ErrorText, Loading } from './status'

describe('status primitives', () => {
  it('Loading is a polite status line with the standard copy', () => {
    render(<Loading />)
    expect(screen.getByRole('status').textContent).toBe('Loading…')
  })

  it('ErrorText renders an assertive alert for a message', () => {
    render(<ErrorText>boom</ErrorText>)
    expect(screen.getByRole('alert').textContent).toBe('boom')
  })

  it('ErrorText renders nothing for an empty/absent message', () => {
    const { container: c1 } = render(<ErrorText>{null}</ErrorText>)
    expect(c1.querySelector('[role="alert"]')).toBeNull()
    const { container: c2 } = render(<ErrorText>{''}</ErrorText>)
    expect(c2.querySelector('[role="alert"]')).toBeNull()
    const { container: c3 } = render(<ErrorText />)
    expect(c3.querySelector('[role="alert"]')).toBeNull()
  })

  it('EmptyState renders muted copy', () => {
    render(<EmptyState>No worlds yet.</EmptyState>)
    const el = screen.getByText('No worlds yet.')
    expect(el.className).toContain('empty-state')
  })
})
