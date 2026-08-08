import { fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { FormCard } from './form-card'
import { Panel } from './panel'
import { TextAreaField } from './text-area-field'

describe('Panel', () => {
  it('wraps content in the shared full-width .panel card', () => {
    render(
      <Panel ariaLabel="Mira">
        <h2>Mira</h2>
        <p>a fixer</p>
      </Panel>,
    )
    const region = screen.getByRole('region', { name: 'Mira' })
    expect(region.className).toContain('panel')
    expect(screen.getByRole('heading', { name: 'Mira' })).toBeTruthy()
  })
})

describe('FormCard', () => {
  it('renders a titled form and submits without reloading the page', () => {
    const onSubmit = vi.fn()
    render(
      <FormCard title="New Thing" onSubmit={onSubmit}>
        <button type="submit">Go</button>
      </FormCard>,
    )
    expect(screen.getByRole('heading', { name: 'New Thing' })).toBeTruthy()
    // the form's accessible name defaults to its title
    expect(screen.getByRole('form', { name: 'New Thing' })).toBeTruthy()

    const form = screen.getByRole('form', { name: 'New Thing' })
    const submit = new Event('submit', { bubbles: true, cancelable: true })
    form.dispatchEvent(submit)
    expect(onSubmit).toHaveBeenCalledOnce()
    expect(submit.defaultPrevented).toBe(true) // preventDefault is owned by FormCard
  })

  it('lets ariaLabel override the form name independently of the visible title', () => {
    render(
      <FormCard title="Visible Title" ariaLabel="a11y name" onSubmit={vi.fn()}>
        <span>body</span>
      </FormCard>,
    )
    expect(screen.getByRole('heading', { name: 'Visible Title' })).toBeTruthy()
    expect(screen.getByRole('form', { name: 'a11y name' })).toBeTruthy()
  })

  it('omits the heading when used title-less (in-place editor), named by ariaLabel', () => {
    render(
      <FormCard ariaLabel="Edit entity" onSubmit={vi.fn()}>
        <button type="submit">Save</button>
      </FormCard>,
    )
    const form = screen.getByRole('form', { name: 'Edit entity' })
    expect(form.className).toContain('panel') // still the full-width card
    expect(screen.queryByRole('heading')).toBeNull()
  })
})

describe('TextAreaField', () => {
  function Harness({
    ariaLabel,
    rows,
    placeholder,
  }: {
    ariaLabel?: string
    rows?: number
    placeholder?: string
  }): React.JSX.Element {
    const [value, setValue] = useState('')
    return (
      <TextAreaField
        label="Body"
        value={value}
        onChange={setValue}
        {...(ariaLabel ? { ariaLabel } : {})}
        {...(rows ? { rows } : {})}
        {...(placeholder ? { placeholder } : {})}
      />
    )
  }

  it('uses the visible label as the accessible name by default', () => {
    render(<Harness />)
    const box = screen.getByLabelText('Body') as HTMLTextAreaElement
    fireEvent.change(box, { target: { value: 'typed' } })
    expect(box.value).toBe('typed')
  })

  it('lets ariaLabel override the accessible name beside a longer visible prompt', () => {
    render(<Harness ariaLabel="terse name" />)
    expect(screen.getByLabelText('terse name')).toBeTruthy()
    expect(screen.getByText('Body')).toBeTruthy() // visible prompt still rendered
  })

  it('forwards rows and placeholder to the textarea when supplied', () => {
    render(<Harness rows={8} placeholder="Write…" />)
    const box = screen.getByPlaceholderText('Write…') as HTMLTextAreaElement
    expect(box.rows).toBe(8)
  })
})
