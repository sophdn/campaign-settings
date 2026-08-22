import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import type { WikiEntry } from '../api'
import { EntityDescription, buildWikiNameIndex, splitDescription } from './entity-description'

describe('splitDescription', () => {
  it('splits a body into ordered text and bracket chunks', () => {
    expect(splitDescription('Met [[Mira]] in [[Ashen]].')).toEqual([
      { kind: 'text', value: 'Met ' },
      { kind: 'bracket', name: 'Mira' },
      { kind: 'text', value: ' in ' },
      { kind: 'bracket', name: 'Ashen' },
      { kind: 'text', value: '.' },
    ])
  })

  it('returns a single text chunk when there are no references', () => {
    expect(splitDescription('just prose')).toEqual([{ kind: 'text', value: 'just prose' }])
  })
})

describe('buildWikiNameIndex', () => {
  it('resolves name collisions by resolver precedence (npc before location)', () => {
    const entries: WikiEntry[] = [
      { kind: 'location', id: 'l1', name: 'Raven' },
      { kind: 'npc', id: 'n1', name: 'Raven' },
    ]
    expect(buildWikiNameIndex(entries).get('raven')).toEqual({ kind: 'npc', id: 'n1' })
  })

  it('keeps entries of unranked kinds resolvable (appended after the ranked ones)', () => {
    const entries: WikiEntry[] = [
      { kind: 'npc', id: 'n1', name: 'Mira' },
      { kind: 'session', id: 's1', name: 'Heist' }, // not in the resolver order
    ]
    const index = buildWikiNameIndex(entries)
    expect(index.get('heist')).toEqual({ kind: 'session', id: 's1' })
    expect(index.get('mira')).toEqual({ kind: 'npc', id: 'n1' })
  })
})

describe('EntityDescription', () => {
  const index = buildWikiNameIndex([{ kind: 'npc', id: 'e2', name: 'Connie' }])

  const renderDesc = (text: string): void => {
    render(
      <MemoryRouter>
        <EntityDescription text={text} worldId="w1" nameIndex={index} />
      </MemoryRouter>,
    )
  }

  it('turns a resolved [[name]] into a link to the entity', () => {
    renderDesc('Allied with [[Connie]].')
    const link = screen.getByRole('link', { name: 'Connie' })
    expect(link.getAttribute('href')).toBe('/worlds/w1/npc/e2')
    expect(screen.getByText('Allied with', { exact: false })).toBeTruthy()
  })

  it('renders an unresolved [[name]] as a broken (non-link) reference', () => {
    renderDesc('Mentions [[Ghost]].')
    expect(screen.queryByRole('link', { name: 'Ghost' })).toBeNull()
    const broken = screen.getByText('Ghost')
    expect(broken.className).toContain('broken-link')
  })
})
