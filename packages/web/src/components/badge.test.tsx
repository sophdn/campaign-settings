import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Badge } from './badge'

describe('Badge', () => {
  it('renders a neutral pill by default', () => {
    render(<Badge>owner</Badge>)
    const el = screen.getByText('owner')
    expect(el.className).toBe('badge')
    expect(el.getAttribute('style')).toBeNull()
  })

  it('keeps a legacy hook class and tints the label via color', () => {
    render(
      <Badge className="wiki-kind" color="var(--color-accent)">
        NPC
      </Badge>,
    )
    const el = screen.getByText('NPC')
    expect(el.className).toBe('badge wiki-kind')
    expect(el.style.color).toBe('var(--color-accent)')
  })
})
