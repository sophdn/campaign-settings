import { describe, expect, it } from 'vitest'
import type { EntityGraph } from '../api'
import { layoutGraph } from './wiki-graph-layout'

const W = 640
const H = 420
const PAD = 24

describe('layoutGraph', () => {
  it('returns an empty map for an empty graph', () => {
    const pos = layoutGraph({ nodes: [], edges: [] }, { width: W, height: H })
    expect(pos.size).toBe(0)
  })

  it('positions every node inside the padded box and is deterministic', () => {
    const graph: EntityGraph = {
      nodes: [
        { kind: 'npc', id: 'a', name: 'A' },
        { kind: 'settlement', id: 'b', name: 'B' },
        { kind: 'npc', id: 'c', name: 'C' },
      ],
      edges: [
        {
          from: { kind: 'npc', id: 'a' },
          to: { kind: 'settlement', id: 'b' },
          type: 'description',
        },
      ],
    }
    const run = (): Map<string, { x: number; y: number }> =>
      layoutGraph(graph, { width: W, height: H, iterations: 50 })
    const pos = run()
    expect(pos.size).toBe(3)
    for (const p of pos.values()) {
      expect(p.x).toBeGreaterThanOrEqual(PAD)
      expect(p.x).toBeLessThanOrEqual(W - PAD)
      expect(p.y).toBeGreaterThanOrEqual(PAD)
      expect(p.y).toBeLessThanOrEqual(H - PAD)
    }
    // deterministic: same input → same output (no randomness)
    expect(run().get('a')).toEqual(pos.get('a'))
  })

  it('fills the box — the settled graph spans the padded area, not a tiny clump', () => {
    // a hub with four leaves (a mind-map shape)
    const graph: EntityGraph = {
      nodes: ['a', 'b', 'c', 'd', 'e'].map((id) => ({ kind: 'npc' as const, id, name: id })),
      edges: ['b', 'c', 'd', 'e'].map((id) => ({
        from: { kind: 'npc' as const, id: 'a' },
        to: { kind: 'npc' as const, id },
        type: 'description' as const,
      })),
    }
    const pos = layoutGraph(graph, { width: W, height: H })
    const xs = [...pos.values()].map((p) => p.x)
    const ys = [...pos.values()].map((p) => p.y)
    const LAYOUT_PAD = 40 // the layout's own fit padding (>= the test's PAD)
    const availW = W - 2 * LAYOUT_PAD
    const availH = H - 2 * LAYOUT_PAD
    // stays inside the padded box…
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(LAYOUT_PAD - 1)
    expect(Math.max(...xs)).toBeLessThanOrEqual(W - LAYOUT_PAD + 1)
    // …and fills the box: the limiting axis spans the full available area
    const xRange = Math.max(...xs) - Math.min(...xs)
    const yRange = Math.max(...ys) - Math.min(...ys)
    expect(xRange > availW - 1 || yRange > availH - 1).toBe(true)
  })

  it('nudges coincident nodes apart instead of dividing by zero', () => {
    // A zero-width box makes the seed radius 0, so every node seeds at the same
    // point — exercising the coincident-node nudge in the repulsion step.
    const graph: EntityGraph = {
      nodes: [
        { kind: 'npc', id: 'a', name: 'A' },
        { kind: 'npc', id: 'b', name: 'B' },
      ],
      edges: [],
    }
    const pos = layoutGraph(graph, { width: 0, height: H, iterations: 5 })
    expect(pos.size).toBe(2)
    for (const p of pos.values()) {
      expect(Number.isFinite(p.x)).toBe(true)
      expect(Number.isFinite(p.y)).toBe(true)
    }
  })

  it('ignores an edge whose endpoint is not a node (defensive)', () => {
    const graph: EntityGraph = {
      nodes: [{ kind: 'npc', id: 'a', name: 'A' }],
      edges: [
        { from: { kind: 'npc', id: 'a' }, to: { kind: 'npc', id: 'ghost' }, type: 'description' },
      ],
    }
    const pos = layoutGraph(graph, { width: W, height: H, iterations: 10 })
    expect(pos.has('a')).toBe(true)
    expect(pos.has('ghost')).toBe(false)
  })

  it('spreads the cloud across the canvas instead of relaxing into a circle', () => {
    // The forces are otherwise isotropic, so the settled cloud would be round —
    // and a round cloud in a wide box fits by HEIGHT, leaving nearly half the
    // width empty. Node labels extend rightward, so that wasted width is
    // exactly the room they need. Measured on a 67-node graph, the round layout
    // used 495 of the 880 available.
    const nodes = Array.from({ length: 40 }, (_, i) => ({
      kind: 'npc',
      id: `n${i}`,
      name: `n${i}`,
    }))
    const edges = nodes.slice(1).map((node, i) => ({
      from: { kind: 'npc', id: node.id },
      to: { kind: 'npc', id: `n${i % 5}` },
      type: 'description' as const,
    }))
    const pos = layoutGraph({ nodes, edges }, { width: 960, height: 600 })
    const xs = [...pos.values()].map((q) => q.x)
    const ys = [...pos.values()].map((q) => q.y)
    const spanX = Math.max(...xs) - Math.min(...xs)
    const spanY = Math.max(...ys) - Math.min(...ys)

    // The usable box is 880x520 (1.69:1); a circular cloud lands near 1:1.
    expect(spanX / spanY).toBeGreaterThan(1.3)
    // …and it genuinely uses the width rather than sitting in a column.
    expect(spanX).toBeGreaterThan(700)
  })
})
