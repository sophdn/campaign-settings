import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useParams } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import type { ApiClient, EntityGraph, MemberRole, WikiEntry } from '../api'
import { ApiProvider } from '../app/api-context'
import { WorldRoleProvider } from '../app/world-context'
import { makeApi } from '../testing/fake-api'
import { WikiPage } from './wiki-page'

function Detail(): React.JSX.Element {
  const { kind, id } = useParams()
  return (
    <p>
      detail {kind} {id}
    </p>
  )
}

function mount(api: ApiClient, role: MemberRole = 'owner'): void {
  render(
    <ApiProvider value={api}>
      <WorldRoleProvider value={{ worldId: 'w1', worldName: 'W', role, refreshWorld: vi.fn() }}>
        <MemoryRouter initialEntries={['/worlds/w1']}>
          <Routes>
            <Route path="/worlds/:worldId" element={<WikiPage />} />
            <Route path="/worlds/:worldId/:kind/:id" element={<Detail />} />
          </Routes>
        </MemoryRouter>
      </WorldRoleProvider>
    </ApiProvider>,
  )
}

const entries: WikiEntry[] = [
  { kind: 'npc', id: 'n1', name: 'Mira' },
  { kind: 'settlement', id: 's1', name: 'Ashen' },
  { kind: 'session', id: 'se1', name: 'Session 1' },
]

const withEntries = (over: Partial<ApiClient> = {}): ApiClient =>
  makeApi({ listWiki: vi.fn(() => Promise.resolve(entries)), ...over })

const graph: EntityGraph = {
  nodes: [
    { kind: 'npc', id: 'n1', name: 'Mira' },
    { kind: 'settlement', id: 's1', name: 'Ashen' },
  ],
  edges: [
    { from: { kind: 'npc', id: 'n1' }, to: { kind: 'settlement', id: 's1' }, type: 'description' },
  ],
}

describe('WikiPage list', () => {
  it('lists wiki entries with kind labels and links through to detail', async () => {
    mount(withEntries())
    expect(await screen.findByRole('heading', { name: 'Wiki' })).toBeTruthy()
    expect(screen.getByText('Mira')).toBeTruthy()
    // kind badges (scoped to the list — the filter dropdown also holds the labels)
    expect(screen.getByText('NPC', { selector: '.wiki-kind' })).toBeTruthy()
    expect(screen.getByText('Settlement', { selector: '.wiki-kind' })).toBeTruthy()
    expect(screen.getByRole('link', { name: /Mira/ }).getAttribute('href')).toBe(
      '/worlds/w1/npc/n1',
    )
  })

  it('filters by search query', async () => {
    mount(withEntries())
    await screen.findByText('Mira')
    fireEvent.change(screen.getByLabelText('Search wiki'), { target: { value: 'ashen' } })
    await waitFor(() => expect(screen.queryByText('Mira')).toBeNull())
    expect(screen.getByText('Ashen')).toBeTruthy()
  })

  it('filters by kind', async () => {
    mount(withEntries())
    await screen.findByText('Mira')
    fireEvent.change(screen.getByLabelText('Filter by kind'), { target: { value: 'session' } })
    expect(screen.getByText('Session 1')).toBeTruthy()
    expect(screen.queryByText('Mira')).toBeNull()
  })

  it('sorts by kind label', async () => {
    mount(withEntries())
    await screen.findByText('Mira')
    fireEvent.change(screen.getByLabelText('Sort'), { target: { value: 'kind' } })
    const items = screen.getAllByRole('listitem').map((li) => li.textContent)
    // kind labels sort: NPC, Session, Settlement
    expect(items[0]).toContain('Mira')
    expect(items[1]).toContain('Session 1')
    expect(items[2]).toContain('Ashen')
  })

  it('falls back to the id when an entry has no name', async () => {
    mount(
      withEntries({
        listWiki: vi.fn(() => Promise.resolve([{ kind: 'npc', id: 'no-name', name: '' }])),
      }),
    )
    expect(await screen.findByRole('link', { name: /no-name/ })).toBeTruthy()
  })

  it('shows an empty state when there are no entities', async () => {
    mount(withEntries({ listWiki: vi.fn(() => Promise.resolve([])) }))
    expect(await screen.findByText('No entities yet.')).toBeTruthy()
  })

  it('shows a loading and then an error state', async () => {
    mount(withEntries({ listWiki: vi.fn(() => Promise.reject(new Error('wiki boom'))) }))
    expect((await screen.findByRole('alert')).textContent).toBe('wiki boom')
  })
})

describe('WikiPage graph view', () => {
  it('renders an interactive graph: nodes coloured by kind, edges drawn', async () => {
    mount(withEntries({ getGraph: vi.fn(() => Promise.resolve(graph)) }))
    await screen.findByText('Mira')
    fireEvent.click(screen.getByRole('button', { name: 'Graph' }))

    const svg = await screen.findByRole('img', { name: 'Entity relationship graph' })
    const mira = screen.getByRole('button', { name: 'Mira' })
    const ashen = screen.getByRole('button', { name: 'Ashen' })
    expect(mira.querySelector('circle')?.getAttribute('fill')).toBe('var(--color-accent)') // npc
    expect(ashen.querySelector('circle')?.getAttribute('fill')).toBe('var(--color-success)') // settlement
    expect(svg.querySelectorAll('line')).toHaveLength(1)
    // a stray move with no node held is a no-op
    fireEvent.mouseMove(svg, { clientX: 3, clientY: 3 })
  })

  it('styles edges by type: touch is accent, bracket is dashed', async () => {
    const g: EntityGraph = {
      nodes: [
        { kind: 'npc', id: 'n1', name: 'Mira' },
        { kind: 'session', id: 'se1', name: 'S1' },
        { kind: 'settlement', id: 's1', name: 'Ashen' },
      ],
      edges: [
        { from: { kind: 'npc', id: 'n1' }, to: { kind: 'session', id: 'se1' }, type: 'touch' },
        {
          from: { kind: 'settlement', id: 's1' },
          to: { kind: 'session', id: 'se1' },
          type: 'bracket',
        },
      ],
    }
    mount(withEntries({ getGraph: vi.fn(() => Promise.resolve(g)) }))
    await screen.findByText('Mira')
    fireEvent.click(screen.getByRole('button', { name: 'Graph' }))
    const svg = await screen.findByRole('img', { name: 'Entity relationship graph' })
    const lines = Array.from(svg.querySelectorAll('line'))
    expect(lines.some((l) => l.getAttribute('stroke') === 'var(--color-accent)')).toBe(true) // touch
    expect(lines.some((l) => l.getAttribute('stroke-dasharray') === '4 3')).toBe(true) // bracket
  })

  it('clicks a node through to its detail page', async () => {
    mount(withEntries({ getGraph: vi.fn(() => Promise.resolve(graph)) }))
    await screen.findByText('Mira')
    fireEvent.click(screen.getByRole('button', { name: 'Graph' }))
    const svg = await screen.findByRole('img', { name: 'Entity relationship graph' })
    fireEvent.mouseDown(screen.getByRole('button', { name: 'Mira' }), { clientX: 0, clientY: 0 })
    fireEvent.mouseUp(svg)
    expect(await screen.findByText('detail npc n1')).toBeTruthy()
  })

  it('drags a node without navigating', async () => {
    mount(withEntries({ getGraph: vi.fn(() => Promise.resolve(graph)) }))
    await screen.findByText('Mira')
    fireEvent.click(screen.getByRole('button', { name: 'Graph' }))
    const svg = await screen.findByRole('img', { name: 'Entity relationship graph' })
    const ashen = screen.getByRole('button', { name: 'Ashen' })
    const before = ashen.getAttribute('transform')
    fireEvent.mouseDown(ashen, { clientX: 0, clientY: 0 })
    fireEvent.mouseMove(svg, { clientX: 120, clientY: 90 })
    fireEvent.mouseUp(svg)
    // dragged by the cursor delta → position changed, and the drag suppressed navigation
    expect(ashen.getAttribute('transform')).not.toBe(before)
    expect(screen.queryByText(/^detail/)).toBeNull()
  })

  it('treats a sub-threshold move as a click (still navigates)', async () => {
    mount(withEntries({ getGraph: vi.fn(() => Promise.resolve(graph)) }))
    await screen.findByText('Mira')
    fireEvent.click(screen.getByRole('button', { name: 'Graph' }))
    const svg = await screen.findByRole('img', { name: 'Entity relationship graph' })
    fireEvent.mouseDown(screen.getByRole('button', { name: 'Mira' }), { clientX: 10, clientY: 10 })
    fireEvent.mouseMove(svg, { clientX: 12, clientY: 11 }) // < threshold → not a drag
    fireEvent.mouseUp(svg)
    expect(await screen.findByText('detail npc n1')).toBeTruthy()
  })

  const openGraph = async (): Promise<SVGSVGElement> => {
    mount(withEntries({ getGraph: vi.fn(() => Promise.resolve(graph)) }))
    await screen.findByText('Mira')
    fireEvent.click(screen.getByRole('button', { name: 'Graph' }))
    return (await screen.findByRole('img', {
      name: 'Entity relationship graph',
    })) as unknown as SVGSVGElement
  }
  const viewBoxWidth = (svg: SVGSVGElement): number =>
    Number(svg.getAttribute('viewBox')!.split(' ')[2])

  it('pans the canvas when dragging the background', async () => {
    const svg = await openGraph()
    const before = svg.getAttribute('viewBox')
    // mousedown on the bare svg (target === currentTarget) starts a pan
    fireEvent.mouseDown(svg, { clientX: 100, clientY: 100 })
    fireEvent.mouseMove(svg, { clientX: 170, clientY: 140 })
    fireEvent.mouseUp(svg)
    expect(svg.getAttribute('viewBox')).not.toBe(before)
    // a pan must not navigate
    expect(screen.queryByText(/^detail/)).toBeNull()
  })

  it('zooms in/out via the controls and resets', async () => {
    const svg = await openGraph()
    const initial = viewBoxWidth(svg)
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }))
    expect(viewBoxWidth(svg)).toBeLessThan(initial)
    fireEvent.click(screen.getByRole('button', { name: 'Reset view' }))
    expect(viewBoxWidth(svg)).toBe(initial)
    fireEvent.click(screen.getByRole('button', { name: 'Zoom out' }))
    expect(viewBoxWidth(svg)).toBeGreaterThan(initial)
  })

  it('zooms with the mouse wheel', async () => {
    const svg = await openGraph()
    const initial = viewBoxWidth(svg)
    fireEvent.wheel(svg, { deltaY: -150 }) // wheel up → zoom in → smaller viewBox
    const zoomedIn = viewBoxWidth(svg)
    expect(zoomedIn).toBeLessThan(initial)
    fireEvent.wheel(svg, { deltaY: 300 }) // wheel down → zoom back out
    expect(viewBoxWidth(svg)).toBeGreaterThan(zoomedIn)
  })

  it('scales pan and cursor-anchored zoom by the rendered size when measured', async () => {
    const svg = await openGraph()
    // jsdom reports a 0x0 rect (no layout); fake a measured size so the
    // screen-px → viewBox-unit scaling and cursor-anchored zoom math run.
    svg.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 480, height: 300, right: 480, bottom: 300, x: 0, y: 0 }) as DOMRect
    const before = svg.getAttribute('viewBox')
    fireEvent.mouseDown(svg, { clientX: 10, clientY: 10 })
    fireEvent.mouseMove(svg, { clientX: 60, clientY: 40 })
    fireEvent.mouseUp(svg)
    expect(svg.getAttribute('viewBox')).not.toBe(before)
    fireEvent.wheel(svg, { deltaY: -100, clientX: 240, clientY: 150 })
    expect(viewBoxWidth(svg)).toBeLessThan(960)
  })

  it('shows an empty graph message', async () => {
    mount(withEntries({ getGraph: vi.fn(() => Promise.resolve({ nodes: [], edges: [] })) }))
    await screen.findByText('Mira')
    fireEvent.click(screen.getByRole('button', { name: 'Graph' }))
    expect(await screen.findByText('No linked entities yet.')).toBeTruthy()
  })

  it('surfaces a graph load error', async () => {
    mount(withEntries({ getGraph: vi.fn(() => Promise.reject(new Error('graph boom'))) }))
    await screen.findByText('Mira')
    fireEvent.click(screen.getByRole('button', { name: 'Graph' }))
    expect((await screen.findByRole('alert')).textContent).toBe('graph boom')
  })
})
