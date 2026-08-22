import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import { BackLink } from './back-link'

describe('BackLink', () => {
  it('links to the destination, with the arrow hidden from the accessible name', () => {
    render(
      <MemoryRouter>
        <BackLink to="/worlds/w1">Back to wiki</BackLink>
      </MemoryRouter>,
    )
    const link = screen.getByRole('link', { name: 'Back to wiki' })
    expect(link.getAttribute('href')).toBe('/worlds/w1')
  })
})
