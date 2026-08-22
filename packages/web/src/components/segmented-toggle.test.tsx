import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { SegmentedToggle } from './segmented-toggle'

const OPTIONS = [
  { value: 'list', label: 'List' },
  { value: 'graph', label: 'Graph' },
] as const

describe('SegmentedToggle', () => {
  it('marks the active option pressed and the rest unpressed', () => {
    render(<SegmentedToggle label="View mode" value="list" onChange={vi.fn()} options={OPTIONS} />)
    expect(screen.getByRole('group', { name: 'View mode' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'List' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('button', { name: 'Graph' }).getAttribute('aria-pressed')).toBe('false')
  })

  it('reports the chosen value on click', () => {
    const onChange = vi.fn()
    render(<SegmentedToggle label="View mode" value="list" onChange={onChange} options={OPTIONS} />)
    fireEvent.click(screen.getByRole('button', { name: 'Graph' }))
    expect(onChange).toHaveBeenCalledWith('graph')
  })
})
