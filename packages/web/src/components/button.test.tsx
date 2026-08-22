import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { Button } from './button'

describe('Button', () => {
  it('defaults to the primary variant and forwards clicks', () => {
    const onClick = vi.fn()
    render(<Button onClick={onClick}>Save</Button>)
    const btn = screen.getByRole('button', { name: 'Save' })
    expect(btn.className).toContain('btn-primary')
    fireEvent.click(btn)
    expect(onClick).toHaveBeenCalled()
  })

  it('appends a caller-provided className', () => {
    render(<Button className="wide">Go</Button>)
    expect(screen.getByRole('button', { name: 'Go' }).className).toContain('wide')
  })

  it('applies the chosen variant and passes native props (type, disabled)', () => {
    render(
      <Button variant="danger" type="submit" disabled>
        Delete
      </Button>,
    )
    const btn = screen.getByRole('button', { name: 'Delete' }) as HTMLButtonElement
    expect(btn.className).toContain('btn-danger')
    expect(btn.type).toBe('submit')
    expect(btn.disabled).toBe(true)
  })
})
