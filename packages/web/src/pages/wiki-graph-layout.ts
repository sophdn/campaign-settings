import type { EntityGraph } from '../api'

export interface Point {
  x: number
  y: number
}

export interface LayoutOptions {
  width: number
  height: number
  /** Simulation steps. More = more settled; small worlds settle fast. */
  iterations?: number
}

const REPULSION = 9000 // pairwise charge — pushes nodes apart (~ REPULSION/d)
const SPRING_K = 0.06 // edge stiffness toward the rest length
const SPRING_LENGTH = 80 // rest length of an edge
const GRAVITY = 0.03 // pull toward the cluster centroid (holds it together)
const MAX_STEP = 40 // per-iteration displacement cap (stability)
const PADDING = 40 // margin when fitting the settled graph into the box
const MIN_DIST2 = 0.01

/**
 * How much weaker the horizontal pull is than the vertical one.
 *
 * The forces are otherwise isotropic, so the cloud relaxes into a circle no
 * matter what shape the canvas is — and `fitToBox` scales uniformly, so a round
 * cloud in a 880×520 box fits by HEIGHT and leaves ~44% of the width empty.
 * Easing the horizontal gravity lets the cloud stay as wide as the box.
 *
 * This is worth more than it sounds: node labels extend to the RIGHT, so
 * horizontal room is the axis that actually decides whether they collide. On a
 * 67-node graph this alone took label collisions from 29 to 21.
 */
const HORIZONTAL_GRAVITY = 0.35

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v))

/**
 * A tiny deterministic force-directed layout (no deps, no randomness) that
 * settles into a mind-map: hubs gravitate to the middle, leaves fan outward.
 * Nodes start on a seed ellipse shaped like the canvas (by index, so the same
 * graph always lays out the same way), then settle under pairwise repulsion,
 * per-edge springs (toward a rest length, not collapse), and a centroid gravity
 * that pulls harder vertically than horizontally so the cloud keeps the box's
 * proportions instead of relaxing into a circle. The simulation runs
 * UNBOUNDED — no per-step clamping to the box, which is what pins nodes to the
 * edges — then the settled cloud is scaled + centred to fill the [PADDING,
 * size-PADDING] box. O(n²·iterations), fine for the tens of nodes a world has.
 */
export function layoutGraph(graph: EntityGraph, opts: LayoutOptions): Map<string, Point> {
  const { width, height, iterations = 300 } = opts
  const { nodes, edges } = graph
  const pos = new Map<string, Point>()
  const n = nodes.length
  if (n === 0) return pos
  if (n === 1) return new Map([[nodes[0]!.id, { x: width / 2, y: height / 2 }]])

  // Seeded on an ELLIPSE matching the canvas, not a circle: the simulation
  // barely changes a cloud's overall shape, so the seed is most of what decides
  // whether the settled graph is round or wide.
  nodes.forEach((node, i) => {
    const angle = (2 * Math.PI * i) / n
    pos.set(node.id, {
      x: width / 2 + Math.cos(angle) * (width / 3),
      y: height / 2 + Math.sin(angle) * (height / 3),
    })
  })

  // only edges whose endpoints are real nodes (dangling links are ignored)
  const liveEdges = edges.filter((e) => pos.has(e.from.id) && pos.has(e.to.id))

  for (let step = 0; step < iterations; step++) {
    const disp = new Map<string, Point>(nodes.map((nd) => [nd.id, { x: 0, y: 0 }]))

    // pairwise repulsion
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const a = pos.get(nodes[i]!.id)!
        const b = pos.get(nodes[j]!.id)!
        let dx = a.x - b.x
        let dy = a.y - b.y
        let d2 = dx * dx + dy * dy
        if (d2 < MIN_DIST2) {
          // deterministic nudge apart when two nodes coincide (i < j here, so
          // i - j is always negative — a stable, non-zero separation direction)
          dx = i - j
          dy = 1
          d2 = dx * dx + dy * dy
        }
        const f = REPULSION / d2
        const di = disp.get(nodes[i]!.id)!
        const dj = disp.get(nodes[j]!.id)!
        di.x += dx * f
        di.y += dy * f
        dj.x -= dx * f
        dj.y -= dy * f
      }
    }

    // per-edge spring toward SPRING_LENGTH (attracts if stretched, repels if compressed)
    for (const e of liveEdges) {
      const a = pos.get(e.from.id)!
      const b = pos.get(e.to.id)!
      const dx = a.x - b.x
      const dy = a.y - b.y
      const d = Math.sqrt(dx * dx + dy * dy) || 0.01
      const force = SPRING_K * (d - SPRING_LENGTH)
      const ux = (dx / d) * force
      const uy = (dy / d) * force
      const du = disp.get(e.from.id)!
      const dv = disp.get(e.to.id)!
      du.x -= ux
      du.y -= uy
      dv.x += ux
      dv.y += uy
    }

    // gravity toward the centroid keeps disconnected pieces from drifting away
    let cx = 0
    let cy = 0
    for (const nd of nodes) {
      const p = pos.get(nd.id)!
      cx += p.x
      cy += p.y
    }
    cx /= n
    cy /= n

    for (const nd of nodes) {
      const p = pos.get(nd.id)!
      const d = disp.get(nd.id)!
      p.x += clamp(d.x + (cx - p.x) * GRAVITY * HORIZONTAL_GRAVITY, -MAX_STEP, MAX_STEP)
      p.y += clamp(d.y + (cy - p.y) * GRAVITY, -MAX_STEP, MAX_STEP)
    }
  }

  return fitToBox(pos, nodes, width, height)
}

/** Scale + centre the settled cloud to fill the padded box (one axis fills exactly). */
function fitToBox(
  pos: Map<string, Point>,
  nodes: EntityGraph['nodes'],
  width: number,
  height: number,
): Map<string, Point> {
  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity
  for (const nd of nodes) {
    const p = pos.get(nd.id)!
    minX = Math.min(minX, p.x)
    maxX = Math.max(maxX, p.x)
    minY = Math.min(minY, p.y)
    maxY = Math.max(maxY, p.y)
  }
  const spanX = maxX - minX || 1
  const spanY = maxY - minY || 1
  const availW = width - 2 * PADDING
  const availH = height - 2 * PADDING
  const scale = Math.min(availW / spanX, availH / spanY)
  const offX = PADDING + (availW - spanX * scale) / 2
  const offY = PADDING + (availH - spanY * scale) / 2

  const out = new Map<string, Point>()
  for (const nd of nodes) {
    const p = pos.get(nd.id)!
    out.set(nd.id, { x: offX + (p.x - minX) * scale, y: offY + (p.y - minY) * scale })
  }
  return out
}
