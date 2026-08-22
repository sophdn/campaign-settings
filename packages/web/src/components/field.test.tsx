import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { SelectField, TextField } from './field'

describe('TextField', () => {
  it('uses the visible label as the accessible name and reports edits', () => {
    const onChange = vi.fn()
    render(<TextField label="World name" value="" onChange={onChange} />)
    const input = screen.getByLabelText('World name')
    fireEvent.change(input, { target: { value: 'Chicago' } })
    expect(onChange).toHaveBeenCalledWith('Chicago')
  })

  it('honours an ariaLabel override and spreads native props', () => {
    render(
      <TextField
        label="Played at"
        ariaLabel="Played at"
        value="2026-06-27"
        onChange={() => {}}
        placeholder="e.g. 2026-06-27"
        type="text"
      />,
    )
    const input = screen.getByLabelText('Played at') as HTMLInputElement
    expect(input.value).toBe('2026-06-27')
    expect(input.placeholder).toBe('e.g. 2026-06-27')
  })
})

describe('SelectField', () => {
  it('renders options and reports the picked value', () => {
    const onChange = vi.fn()
    render(
      <SelectField
        label="Kind"
        value="npc"
        onChange={onChange}
        options={[
          { value: 'npc', label: 'NPC' },
          { value: 'settlement', label: 'Settlement' },
        ]}
      />,
    )
    fireEvent.change(screen.getByLabelText('Kind'), { target: { value: 'settlement' } })
    expect(onChange).toHaveBeenCalledWith('settlement')
  })
})
