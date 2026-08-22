import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { PageHeader } from './page-header'

describe('PageHeader', () => {
  it('renders the title as an h1', () => {
    render(<PageHeader title="Your worlds" />)
    expect(screen.getByRole('heading', { level: 1, name: 'Your worlds' })).toBeTruthy()
  })

  it('renders actions alongside the title when provided', () => {
    render(<PageHeader title="Wiki" actions={<button>List</button>} />)
    expect(screen.getByRole('heading', { level: 1, name: 'Wiki' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'List' })).toBeTruthy()
  })
})
