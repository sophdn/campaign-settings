import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { Resource } from '../app/use-resource'
import { ResourceView } from './resource-view'

const res = <T,>(partial: Partial<Resource<T>>): Resource<T> => ({
  data: null,
  loading: false,
  error: null,
  reload: () => {},
  ...partial,
})

describe('ResourceView', () => {
  it('shows the loading line while loading', () => {
    render(
      <ResourceView resource={res<number[]>({ loading: true })}>{() => <p>x</p>}</ResourceView>,
    )
    expect(screen.getByRole('status').textContent).toBe('Loading…')
  })

  it('shows an alert on error', () => {
    render(
      <ResourceView resource={res<number[]>({ error: 'nope' })}>{() => <p>x</p>}</ResourceView>,
    )
    expect(screen.getByRole('alert').textContent).toBe('nope')
  })

  it('shows the empty label when empty predicate matches', () => {
    render(
      <ResourceView
        resource={res<number[]>({ data: [] })}
        empty={(d) => d.length === 0}
        emptyLabel={<p>nothing here</p>}
      >
        {() => <p>rows</p>}
      </ResourceView>,
    )
    expect(screen.getByText('nothing here')).toBeTruthy()
  })

  it('renders children with the loaded data', () => {
    render(
      <ResourceView resource={res<number[]>({ data: [1, 2] })} empty={(d) => d.length === 0}>
        {(d) => <p>count {d.length}</p>}
      </ResourceView>,
    )
    expect(screen.getByText('count 2')).toBeTruthy()
  })

  it('renders children when no empty handling is configured', () => {
    render(
      <ResourceView resource={res<{ name: string }>({ data: { name: 'Mira' } })}>
        {(d) => <p>{d.name}</p>}
      </ResourceView>,
    )
    expect(screen.getByText('Mira')).toBeTruthy()
  })
})
