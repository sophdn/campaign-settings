import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import { CardLink } from './card-link'

function mount(node: React.JSX.Element): void {
  render(<MemoryRouter>{node}</MemoryRouter>)
}

describe('CardLink', () => {
  it('renders a titled link to the target as a grid list item', () => {
    mount(
      <ul>
        <CardLink to="/worlds/chicago" title="Chicago" />
      </ul>,
    )
    const link = screen.getByRole('link', { name: 'Chicago' })
    expect(link.getAttribute('href')).toBe('/worlds/chicago')
    expect(link.closest('li')).not.toBeNull()
  })

  it('shows meta text alongside the title when provided', () => {
    mount(
      <ul>
        <CardLink to="/worlds/chicago" title="Chicago" meta="owner" />
      </ul>,
    )
    expect(screen.getByText('owner')).toBeTruthy()
  })

  it('omits the meta element when no meta is given', () => {
    const { container } = render(
      <MemoryRouter>
        <ul>
          <CardLink to="/x" title="X" />
        </ul>
      </MemoryRouter>,
    )
    expect(container.querySelector('.card-link-meta')).toBeNull()
  })
})
