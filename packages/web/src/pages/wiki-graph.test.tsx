import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import type { ApiClient, EntityGraph } from '../api'
import { ApiProvider } from '../app/api-context'
import { makeApi } from '../testing/fake-api'
import { WikiGraph } from './wiki-graph'

/**
 * Label legibility on a dense graph.
 *
 * The complaint this answers: at ~67 nodes the graph was unreadable. Measured,
 * the CIRCLES were barely touching (3 colliding pairs) — it was the LABELS,
 * because an average name is wider than the space each node gets. Two things
 * fix that, and both are asserted here: marks are drawn at a constant SCREEN
 * size so zooming in genuinely buys room rather than magnifying the crowding,
 * and when zoomed out only the hubs (plus whatever is under the cursor) are
 * named.
 */

/** A graph with one obvious hub and a ring of leaves around it. */
function densGraph(n: number): EntityGraph {
  const nodes = Array.from({ length: n }, (_, i) => ({
    kind: 'npc',
    id: `n${i}`,
    name: `Entity Number ${i}`,
  }))
  // n0 is connected to everything, so it is unambiguously the top hub.
  const edges = nodes.slice(1).map((node) => ({
    from: { kind: 'npc', id: node.id },
    to: { kind: 'npc', id: 'n0' },
    type: 'description' as const,
  }))
  return { nodes, edges }
}

function mount(graph: EntityGraph, api?: ApiClient): void {
  render(
    <ApiProvider value={api ?? makeApi({ getGraph: vi.fn(() => Promise.resolve(graph)) })}>
      <MemoryRouter initialEntries={['/worlds/w1']}>
        <Routes>
          <Route path="/worlds/:worldId" element={<WikiGraph />} />
          <Route path="/worlds/:worldId/:kind/:id" element={<h1>Entity page</h1>} />
        </Routes>
      </MemoryRouter>
    </ApiProvider>,
  )
}

const svg = (): SVGSVGElement => document.querySelector('svg') as SVGSVGElement
const labels = (): string[] =>
  [...document.querySelectorAll('text')].map((t) => t.textContent ?? '')
// Testing Library matches an accessible NAME exactly for a string matcher (unlike
// Playwright, which treats it as a substring), so "Entity Number 3" cannot also
// match "Entity Number 39".
const nodeFor = (name: string): Element => screen.getByRole('button', { name })

describe('WikiGraph label legibility', () => {
  it('names only the hubs when zoomed out, not all 40 nodes', async () => {
    mount(densGraph(40))
    await waitFor(() => expect(svg()).toBeTruthy())

    const shown = labels()
    // The hub is named; the long tail is not.
    expect(shown).toContain('Entity Number 0')
    expect(shown.length).toBeLessThan(20)
    expect(shown.length).toBeGreaterThan(0)
  })

  it('names every node once zoomed in', async () => {
    mount(densGraph(40))
    await waitFor(() => expect(svg()).toBeTruthy())
    expect(labels().length).toBeLessThan(40)

    // Three zoom steps (1.2³ ≈ 1.7×) takes the viewBox under the all-labels
    // threshold. Deliberately not two: at ~1.4× the names still collide, and a
    // threshold that reveals them early would put back the crowding this fixes.
    for (let i = 0; i < 3; i++) {
      fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }))
    }

    expect(labels()).toHaveLength(40)
  })

  it('keeps marks a constant size on screen, so zooming creates room', async () => {
    // The load-bearing one. If the font and radii were fixed in viewBox units
    // they would scale WITH the zoom, and zooming in would magnify the crowding
    // instead of relieving it — which is why the graph could not be zoomed into
    // legibility before.
    mount(densGraph(12))
    await waitFor(() => expect(svg()).toBeTruthy())

    const fontAt = (): number =>
      parseFloat(
        (document.querySelector('text') as SVGTextElement).getAttribute('font-size') ?? '0',
      )
    const radiusAt = (): number =>
      parseFloat((document.querySelector('circle') as SVGCircleElement).getAttribute('r') ?? '0')

    const font0 = fontAt()
    const r0 = radiusAt()
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }))

    // The viewBox shrank, so the marks must shrink by the same factor to stay
    // the same size on screen.
    const viewW = parseFloat((svg().getAttribute('viewBox') ?? '0 0 960 600').split(' ')[2] ?? '0')
    const k = viewW / 960
    expect(fontAt()).toBeCloseTo(font0 * k, 4)
    expect(radiusAt()).toBeCloseTo(r0 * k, 4)
  })

  it('names any node under the cursor, at any zoom', async () => {
    // So a single unnamed dot is always identifiable without zooming.
    mount(densGraph(40))
    await waitFor(() => expect(svg()).toBeTruthy())

    const leaf = 'Entity Number 39'
    expect(labels()).not.toContain(leaf)

    fireEvent.mouseEnter(nodeFor(leaf))
    expect(labels()).toContain(leaf)

    fireEvent.mouseLeave(nodeFor(leaf))
    expect(labels()).not.toContain(leaf)
  })

  it('still labels everything on a small graph, where there is room', async () => {
    // The hub cap has a floor, so a sparse world is not needlessly anonymised.
    mount(densGraph(4))
    await waitFor(() => expect(svg()).toBeTruthy())
    expect(labels()).toHaveLength(4)
  })

  it('still navigates on a click, with the hover handlers attached', async () => {
    mount(densGraph(6))
    await waitFor(() => expect(svg()).toBeTruthy())

    const node = nodeFor('Entity Number 3')
    fireEvent.mouseDown(node, { clientX: 10, clientY: 10 })
    fireEvent.mouseUp(node, { clientX: 10, clientY: 10 })

    expect(await screen.findByRole('heading', { name: 'Entity page' })).toBeTruthy()
  })

  it('caps the named hubs on a very large graph', async () => {
    // The share is proportional, so without a ceiling a 400-entity world would
    // open with 60 names on it — reintroducing exactly the crowding this fixes.
    mount(densGraph(140))
    await waitFor(() => expect(svg()).toBeTruthy())

    const shown = labels()
    expect(shown.length).toBeLessThanOrEqual(18)
    expect(shown).toContain('Entity Number 0') // the hub is still among them
  })

  it('keeps naming the newest node when the cursor moves straight between two', async () => {
    // Leaving A after entering B must not clear B's name: the pointer fires
    // enter-B before leave-A, so a leave handler that blindly cleared would
    // blank the label the cursor is actually over.
    mount(densGraph(40))
    await waitFor(() => expect(svg()).toBeTruthy())

    const a = 'Entity Number 38'
    const b = 'Entity Number 39'
    fireEvent.mouseEnter(nodeFor(a))
    fireEvent.mouseEnter(nodeFor(b))
    fireEvent.mouseLeave(nodeFor(a))

    expect(labels()).toContain(b)
    expect(labels()).not.toContain(a)
  })

  it('renders an entity that nothing links to', async () => {
    // An orphan is a normal state in a wiki being written — a page created but
    // not yet referenced. It has no degree at all, so it exercises every
    // "how connected is this?" lookup on its absent entry, and it must still
    // appear rather than vanishing from the world's map.
    const graph = densGraph(6)
    graph.nodes.push({ kind: 'npc', id: 'orphan', name: 'Unreferenced Stranger' })
    mount(graph)
    await waitFor(() => expect(svg()).toBeTruthy())

    expect(nodeFor('Unreferenced Stranger')).toBeTruthy()
    // Smallest radius, because radius tracks connectedness.
    const radii = [...document.querySelectorAll('circle')].map((c) =>
      parseFloat(c.getAttribute('r') ?? '0'),
    )
    expect(Math.min(...radii)).toBeGreaterThan(0)
  })

  it('says so when a world has no links yet, rather than drawing an empty canvas', async () => {
    mount({ nodes: [], edges: [] })
    expect(await screen.findByText('No linked entities yet.')).toBeTruthy()
    expect(document.querySelector('svg')).toBeNull()
  })
})
