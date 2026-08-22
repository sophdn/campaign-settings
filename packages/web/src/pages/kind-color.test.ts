import { describe, expect, it } from 'vitest'
import { kindColor, kindLabel } from './kind-color'

describe('kind-color', () => {
  it('maps a known kind to its themed badge colour and label', () => {
    expect(kindColor('npc')).toBe('var(--color-accent)')
    expect(kindColor('settlement')).toBe('var(--color-success)')
    expect(kindLabel('npc')).toBe('NPC')
  })

  it('falls back to the text colour and the raw kind for an unknown kind', () => {
    expect(kindColor('totally-unknown')).toBe('var(--color-text-secondary)')
    expect(kindLabel('totally-unknown')).toBe('totally-unknown')
  })
})
