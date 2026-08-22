import {
  type MouseEvent as ReactMouseEvent,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useApi } from '../app/api-context'
import { useResource } from '../app/use-resource'
import { kindColor } from './kind-color'
import { layoutGraph, type Point } from './wiki-graph-layout'

// Logical (viewBox) canvas. The SVG scales to fill its container via CSS; the
// live viewBox is panned/zoomed off this base coordinate space + aspect ratio.
const WIDTH = 960
const HEIGHT = 600
const DRAG_THRESHOLD = 4
const NODE_MIN_R = 6
const NODE_MAX_R = 16
const LABEL_FONT = 11

/**
 * Zoom (in viewBox-width terms) at which EVERY node is labelled.
 *
 * Marks are drawn at a constant SCREEN size — see `k` below — so zooming in
 * genuinely buys room for labels rather than magnifying them along with
 * everything else. Below this width the graph has spread far enough that the
 * names fit; above it only hubs and whatever is under the cursor are named.
 */
const LABEL_ALL_BELOW = WIDTH * 0.62

/** Share of nodes that stay named when zoomed out, so the view is never anonymous. */
const HUB_SHARE = 0.15
const HUB_MIN = 4
const HUB_MAX = 18
const ORIGIN: Point = { x: 0, y: 0 }
const ZOOM_STEP = 1.2
const MIN_W = WIDTH / 5 // most zoomed-in
const MAX_W = WIDTH * 2.5 // most zoomed-out

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v))

/** The visible window into the logical canvas — an SVG viewBox `x y w h`. */
interface View {
  x: number
  y: number
  w: number
  h: number
}
const INITIAL_VIEW: View = { x: 0, y: 0, w: WIDTH, h: HEIGHT }

/**
 * Zoom by `factor` (>1 zooms out, <1 zooms in) keeping the point at fractional
 * position (px, py) of the viewport stationary. Aspect ratio stays locked.
 */
function zoomView(v: View, factor: number, px: number, py: number): View {
  const w = clamp(v.w * factor, MIN_W, MAX_W)
  const h = w * (HEIGHT / WIDTH)
  const cx = v.x + px * v.w
  const cy = v.y + py * v.h
  return { x: cx - px * w, y: cy - py * h, w, h }
}

// A drag is either a single node being repositioned or the whole canvas panning.
type Drag =
  | {
      type: 'node'
      id: string
      kind: string
      startX: number
      startY: number
      originX: number
      originY: number
      scaleX: number
      scaleY: number
      moved: boolean
    }
  | {
      type: 'pan'
      startX: number
      startY: number
      startViewX: number
      startViewY: number
      scaleX: number
      scaleY: number
    }

/**
 * Interactive force-directed entity graph. Nodes settle via a deterministic
 * force simulation (layoutGraph), are coloured by kind, can be dragged, and
 * click through to the entity's detail page. The canvas itself pans (drag the
 * background) and zooms (wheel or the on-screen controls). Edge data comes from
 * the server's buildEntityGraph, which already excludes any link with a hidden
 * endpoint — so a player's graph is authorization-correct without client filtering.
 */
export function WikiGraph(): React.JSX.Element {
  const api = useApi()
  const navigate = useNavigate()
  const { worldId = '' } = useParams()
  const fetcher = useCallback(() => api.getGraph(worldId), [api, worldId])
  const { data: graph, loading, error } = useResource(fetcher)

  const base = useMemo(
    () => (graph ? layoutGraph(graph, { width: WIDTH, height: HEIGHT }) : new Map<string, Point>()),
    [graph],
  )
  // node radius scales with degree, so hubs read as the centre of the mind-map
  const degree = useMemo(() => {
    const d = new Map<string, number>()
    for (const e of graph?.edges ?? []) {
      d.set(e.from.id, (d.get(e.from.id) ?? 0) + 1)
      d.set(e.to.id, (d.get(e.to.id) ?? 0) + 1)
    }
    return d
  }, [graph])
  const maxDegree = useMemo(() => {
    let m = 1
    for (const v of degree.values()) m = Math.max(m, v)
    return m
  }, [degree])
  const radiusOf = (id: string): number =>
    NODE_MIN_R + ((degree.get(id) ?? 0) / maxDegree) * (NODE_MAX_R - NODE_MIN_R)

  /**
   * The best-connected nodes, which stay named even zoomed out so the opening
   * view orients rather than presenting an anonymous constellation. Ranked by
   * degree and tie-broken by id, so the set is stable across renders.
   */
  const hubs = useMemo(() => {
    const ranked = [...(graph?.nodes ?? [])].sort(
      // Degree first; id breaks ties so the set is stable across renders rather
      // than depending on whatever order the sort happened to leave equals in.
      (a, b) => (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0) || a.id.localeCompare(b.id),
    )
    const count = Math.min(HUB_MAX, Math.max(HUB_MIN, Math.round(ranked.length * HUB_SHARE)))
    return new Set(ranked.slice(0, count).map((nd) => nd.id))
  }, [graph, degree])

  const [hovered, setHovered] = useState<string | null>(null)

  const [overrides, setOverrides] = useState<Map<string, Point>>(new Map())
  const [view, setView] = useState<View>(INITIAL_VIEW)
  const drag = useRef<Drag | null>(null)
  const svgRef = useRef<SVGSVGElement | null>(null)

  const posOf = (id: string): Point => overrides.get(id) ?? base.get(id) ?? ORIGIN

  // viewBox units per screen pixel — a drag/pan tracks the cursor once the SVG
  // is scaled to its container (1 when unmeasured, e.g. jsdom).
  const scaleXY = (): { sx: number; sy: number } => {
    const rect = svgRef.current?.getBoundingClientRect()
    return {
      sx: rect && rect.width > 0 ? view.w / rect.width : 1,
      sy: rect && rect.height > 0 ? view.h / rect.height : 1,
    }
  }

  // Wheel zoom via a native, non-passive listener so it can preventDefault the
  // page scroll (React's onWheel is passive). Re-attached once the SVG mounts.
  //
  // A LAYOUT effect, not a passive one: layout effects run inside the commit
  // that puts the <svg> in the document, so the canvas can never be on screen
  // (or findable by a test) in a state where a wheel notch does nothing. A
  // passive effect flushes in a later task, and under load that window is wide
  // enough to lose the first notch.
  useLayoutEffect(() => {
    const el = svgRef.current
    if (!el) return
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault()
      const rect = el.getBoundingClientRect()
      const px = rect.width > 0 ? (e.clientX - rect.left) / rect.width : 0.5
      const py = rect.height > 0 ? (e.clientY - rect.top) / rect.height : 0.5
      const factor = e.deltaY < 0 ? 1 / ZOOM_STEP : ZOOM_STEP
      setView((v) => zoomView(v, factor, px, py))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [graph])

  function onNodeDown(e: ReactMouseEvent, id: string, kind: string): void {
    e.preventDefault()
    const p = posOf(id)
    const { sx, sy } = scaleXY()
    drag.current = {
      type: 'node',
      id,
      kind,
      startX: e.clientX,
      startY: e.clientY,
      originX: p.x,
      originY: p.y,
      scaleX: sx,
      scaleY: sy,
      moved: false,
    }
  }

  // A mousedown on the bare background (not a node) starts a canvas pan.
  function onCanvasDown(e: ReactMouseEvent): void {
    if (e.target !== e.currentTarget) return
    e.preventDefault()
    const { sx, sy } = scaleXY()
    drag.current = {
      type: 'pan',
      startX: e.clientX,
      startY: e.clientY,
      startViewX: view.x,
      startViewY: view.y,
      scaleX: sx,
      scaleY: sy,
    }
  }

  function onMove(e: ReactMouseEvent): void {
    const d = drag.current
    if (!d) return
    const dx = e.clientX - d.startX
    const dy = e.clientY - d.startY
    if (d.type === 'pan') {
      // drag the background right → the content follows, so the window moves left
      setView((v) => ({ ...v, x: d.startViewX - dx * d.scaleX, y: d.startViewY - dy * d.scaleY }))
      return
    }
    if (Math.abs(dx) > DRAG_THRESHOLD || Math.abs(dy) > DRAG_THRESHOLD) d.moved = true
    setOverrides((prev) =>
      new Map(prev).set(d.id, { x: d.originX + dx * d.scaleX, y: d.originY + dy * d.scaleY }),
    )
  }

  function onUp(): void {
    const d = drag.current
    drag.current = null
    // a click (node grabbed, never moved) navigates; a pan or drag does not
    if (d && d.type === 'node' && !d.moved) navigate(`/worlds/${worldId}/${d.kind}/${d.id}`)
  }

  const zoomBy = (factor: number): void => setView((v) => zoomView(v, factor, 0.5, 0.5))
  const resetView = (): void => setView(INITIAL_VIEW)

  // viewBox units per BASE unit: 1 when fully zoomed out, smaller as you zoom
  // in. Every on-screen mark is multiplied by it so it keeps a constant size.
  const k = view.w / WIDTH
  const labelsForAll = view.w <= LABEL_ALL_BELOW

  if (loading) return <p role="status">Loading…</p>
  if (error || !graph) return <p role="alert">{error ?? 'Failed to load'}</p>
  if (graph.nodes.length === 0) return <p>No linked entities yet.</p>

  return (
    <div className="wiki-graph-wrap">
      <div className="graph-controls">
        <button type="button" aria-label="Zoom in" onClick={() => zoomBy(1 / ZOOM_STEP)}>
          +
        </button>
        <button type="button" aria-label="Zoom out" onClick={() => zoomBy(ZOOM_STEP)}>
          −
        </button>
        <button type="button" aria-label="Reset view" onClick={resetView}>
          Reset
        </button>
      </div>
      <svg
        ref={svgRef}
        className="wiki-graph"
        viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`}
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label="Entity relationship graph"
        onMouseDown={onCanvasDown}
        onMouseMove={onMove}
        onMouseUp={onUp}
      >
        {graph.edges.map((edge) => {
          const a = posOf(edge.from.id)
          const b = posOf(edge.to.id)
          // A DM's explicit statements are drawn in the accent colour and a
          // parsed one is not: `touch` (an interaction they recorded) and
          // `relationship` (a typed relation) are assertions; `description` and
          // `bracket` are links the app read out of prose. The dash separates
          // the two parsed kinds from each other.
          const asserted = edge.type === 'touch' || edge.type === 'relationship'
          const stroke = asserted ? 'var(--color-accent)' : 'var(--color-border)'
          const dash = edge.type === 'bracket' ? '4 3' : undefined
          return (
            <line
              key={`${edge.type}:${edge.from.id}->${edge.to.id}`}
              // The only handle a test has on an edge: an SVG <line> has no
              // role and no name of its own, so without this "is there an edge
              // between these two" is not a question the DOM can answer.
              data-edge={`${edge.type}:${edge.from.id}:${edge.to.id}`}
              x1={a.x}
              y1={a.y}
              x2={b.x}
              y2={b.y}
              stroke={stroke}
              strokeDasharray={dash}
              strokeWidth={1 * k}
            />
          )
        })}
        {graph.nodes.map((node) => {
          const p = posOf(node.id)
          // Marks are sized in viewBox units, so without `k` they would scale
          // WITH the zoom — magnifying the crowding instead of relieving it.
          // Multiplying by the zoom keeps every circle and label the same size
          // on screen, which is what makes zooming in actually create room.
          const r = radiusOf(node.id) * k
          // A name is shown when there is room for it (zoomed in), when the node
          // is one of the hubs the view is oriented around, or when it is under
          // the cursor — so any single node can always be identified without
          // zooming, and the zoomed-out view is never anonymous.
          const showLabel = labelsForAll || hubs.has(node.id) || hovered === node.id
          return (
            <g
              key={node.id}
              transform={`translate(${p.x}, ${p.y})`}
              onMouseDown={(e) => onNodeDown(e, node.id, node.kind)}
              onMouseEnter={() => setHovered(node.id)}
              onMouseLeave={() => setHovered((cur) => (cur === node.id ? null : cur))}
              style={{ cursor: 'pointer' }}
              role="button"
              aria-label={node.name}
            >
              <circle
                r={r}
                fill={kindColor(node.kind)}
                stroke="var(--color-surface)"
                strokeWidth={1.5 * k}
              />
              {showLabel ? (
                <text
                  x={r + 3 * k}
                  y={4 * k}
                  fontSize={LABEL_FONT * k}
                  fill="var(--color-text-primary)"
                  // The hovered name sits above its neighbours rather than
                  // under whichever node happens to render later.
                  paintOrder="stroke"
                  stroke="var(--color-surface)"
                  strokeWidth={3 * k}
                  strokeLinejoin="round"
                >
                  {node.name}
                </text>
              ) : null}
            </g>
          )
        })}
      </svg>
    </div>
  )
}
