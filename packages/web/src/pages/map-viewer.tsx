import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { MapPin, WorldMap } from '../api'
import { Button } from '../components/button'
import {
  clampPan,
  fitToViewport,
  initialView,
  keyboardPanStep,
  type MapView,
  MAX_SCALE,
  MIN_SCALE,
  panBy,
  type Point,
  type Size,
  viewToImage,
  WHEEL_STEP,
  ZOOM_STEP,
  zoomAbout,
} from './map-viewport'

/**
 * A zoomable, pannable map with its pins.
 *
 * All the arithmetic lives in `map-viewport.ts`, which is unit-tested without
 * rendering anything; this component owns the DOM, the events, and nothing else.
 * That split is what makes "a pin holds its position under zoom" a property with
 * a test rather than something checked by eye.
 *
 * Pins are children of the transformed content layer and positioned in
 * percentages, so the browser moves them with the image for free. Only two
 * things need the transform explicitly: turning a click into a normalized
 * coordinate, and zooming about a point.
 */

/** How far a pointer may travel and still count as a click rather than a drag. */
const DRAG_THRESHOLD = 4

export interface MapViewerProps {
  map: WorldMap
  /** Source URL for the image, or null when the map has none yet. */
  imageUrl: string | null
  pins: MapPin[]
  /** When set, clicking the map reports where — this is the place-a-pin mode. */
  onPlace?: ((at: Point) => void) | null
  /** Following a pin to the entity it marks. */
  onOpenPin?: (pin: MapPin) => void
  /** When set, a pin can be dragged to a new spot, reported in image space. */
  onMovePin?: ((pin: MapPin, to: Point) => void) | null
}

export function MapViewer({
  map,
  imageUrl,
  pins,
  onPlace,
  onOpenPin,
  onMovePin,
}: MapViewerProps): React.JSX.Element {
  const frameRef = useRef<HTMLDivElement>(null)
  const [viewport, setViewport] = useState<Size>({ width: 0, height: 0 })
  const [view, setView] = useState<MapView>({ scale: MIN_SCALE, pan: { x: 0, y: 0 } })

  // A map with no recorded dimensions still has to render — a legacy imported
  // one may carry nulls — so it falls back to filling the frame.
  const source: Size = { width: map.source_width ?? 0, height: map.source_height ?? 0 }
  const base = fitToViewport(source, viewport)

  // Measure the frame, and keep measuring: a phone rotating or a window
  // resizing changes what "fitted" means, and a stale viewport would let the
  // clamp hold the image somewhere it no longer belongs.
  useLayoutEffect(() => {
    const node = frameRef.current
    if (!node) return
    const measure = (): void => {
      const rect = node.getBoundingClientRect()
      setViewport({ width: rect.width, height: rect.height })
    }
    measure()
    if (typeof ResizeObserver !== 'function') return
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  const fitted = base.width > 0 && base.height > 0
  /** The image the current view was fitted to, so a reflow is not mistaken for a new map. */
  const fittedFor = useRef<string | null>(null)

  useEffect(() => {
    if (!fitted) return
    if (fittedFor.current === imageUrl) {
      // Same image, different frame — a pin was added below and the page
      // reflowed, or the phone rotated. Keep the zoom the DM chose and only
      // re-clamp the pan to the new bounds. Re-fitting here would silently
      // throw away their position every time the page changed height.
      setView((current) => ({
        scale: current.scale,
        pan: clampPan(current.pan, base, viewport, current.scale),
      }))
      return
    }
    fittedFor.current = imageUrl
    setView(initialView(base, viewport))
    // Keyed on the measured numbers rather than the object identities, which are
    // fresh on every render.
  }, [fitted, imageUrl, base.width, base.height, viewport.width, viewport.height])

  const zoom = useCallback(
    (factor: number, focus?: Point) => {
      setView((current) =>
        zoomAbout(
          current,
          base,
          viewport,
          focus ?? { x: viewport.width / 2, y: viewport.height / 2 },
          factor,
        ),
      )
    },
    [base.width, base.height, viewport.width, viewport.height],
  )
  const reset = useCallback(() => setView(initialView(base, viewport)), [base, viewport])

  // ── pointer: drag to pan, click to place ──
  const drag = useRef<{ id: number; x: number; y: number; moved: boolean } | null>(null)
  /** A pin being dragged. Separate from the pan drag: they mean different things. */
  const pinDrag = useRef<{ id: string; moved: boolean } | null>(null)
  /** Set by a completed pin drag, so the click that follows it does not navigate. */
  const suppressClick = useRef(false)

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: false }
    e.currentTarget.setPointerCapture(e.pointerId)
  }

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    const state = drag.current
    if (!state || state.id !== e.pointerId) return
    const dx = e.clientX - state.x
    const dy = e.clientY - state.y
    if (!state.moved && Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return
    state.moved = true
    state.x = e.clientX
    state.y = e.clientY
    setView((current) => panBy(current, base, viewport, { x: dx, y: dy }))
  }

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>): void => {
    const state = drag.current
    drag.current = null
    if (!state || state.moved || !onPlace) return
    // A click that did not become a drag, in placement mode: report where on the
    // IMAGE it landed, not where on the screen — that is what gets stored.
    const rect = e.currentTarget.getBoundingClientRect()
    onPlace(viewToImage({ x: e.clientX - rect.left, y: e.clientY - rect.top }, base, view))
  }

  // Wheel zoom is attached natively rather than through React, because a React
  // wheel handler is passive and cannot preventDefault — the page would scroll
  // underneath the map while it zoomed. A LAYOUT effect for the same reason the
  // measurement above is one: it runs inside the commit that puts the frame in
  // the document, so there is no window in which the map is on screen but a
  // wheel notch does nothing.
  useLayoutEffect(() => {
    const node = frameRef.current
    if (!node) return
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault()
      const rect = node.getBoundingClientRect()
      zoom(e.deltaY < 0 ? WHEEL_STEP : 1 / WHEEL_STEP, {
        x: e.clientX - rect.left,
        y: e.clientY - rect.top,
      })
    }
    node.addEventListener('wheel', onWheel, { passive: false })
    return () => node.removeEventListener('wheel', onWheel)
  }, [zoom])

  /**
   * Keyboard parity with the pointer. A map that can only be explored by
   * dragging is a map some people cannot explore at all, and the controls below
   * would otherwise be the only reachable operations.
   */
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    const step = keyboardPanStep(viewport)
    const moves: Record<string, Point> = {
      ArrowLeft: { x: step, y: 0 },
      ArrowRight: { x: -step, y: 0 },
      ArrowUp: { x: 0, y: step },
      ArrowDown: { x: 0, y: -step },
    }
    const move = moves[e.key]
    if (move) {
      e.preventDefault()
      setView((current) => panBy(current, base, viewport, move))
      return
    }
    if (e.key === '+' || e.key === '=') {
      e.preventDefault()
      zoom(ZOOM_STEP)
    } else if (e.key === '-' || e.key === '_') {
      e.preventDefault()
      zoom(1 / ZOOM_STEP)
    } else if (e.key === '0') {
      e.preventDefault()
      reset()
    }
  }

  if (!imageUrl) {
    return (
      <div className="map-frame map-frame-empty" data-testid="map-frame">
        <p>No image yet. Upload one to start placing pins.</p>
      </div>
    )
  }

  const content = { width: base.width * view.scale, height: base.height * view.scale }

  return (
    <div
      ref={frameRef}
      className="map-frame"
      data-testid="map-frame"
      role="application"
      tabIndex={0}
      aria-label={`Map: ${map.name}. Arrow keys pan, plus and minus zoom, 0 resets.`}
      onKeyDown={onKeyDown}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => (drag.current = null)}
      style={{ cursor: onPlace ? 'crosshair' : 'grab' }}
    >
      <div
        className="map-content"
        data-testid="map-content"
        style={{
          left: `${view.pan.x}px`,
          top: `${view.pan.y}px`,
          width: `${content.width}px`,
          height: `${content.height}px`,
        }}
      >
        <img src={imageUrl} alt={`Map of ${map.name}`} draggable={false} />
        {pins.map((pin) => (
          <button
            key={pin.id}
            type="button"
            className="map-pin"
            // Percentages of the content layer, so the browser keeps each pin
            // over the same point of the image through every zoom and pan.
            style={{ left: `${pin.x * 100}%`, top: `${pin.y * 100}%` }}
            // Stop the frame from reading this as a pan or a placement — a pin
            // sits on top of the surface both of those listen to.
            onPointerDown={(e) => {
              e.stopPropagation()
              if (onMovePin) pinDrag.current = { id: pin.id, moved: false }
            }}
            onPointerMove={(e) => {
              const state = pinDrag.current
              if (!state || state.id !== pin.id || !onMovePin) return
              e.stopPropagation()
              state.moved = true
            }}
            onPointerUp={(e) => {
              const state = pinDrag.current
              pinDrag.current = null
              e.stopPropagation()
              if (!state?.moved || !onMovePin) return
              const rect = e.currentTarget.parentElement?.getBoundingClientRect()
              if (!rect) return
              // The content layer's own box already accounts for the pan, so the
              // conversion runs against a zero offset.
              onMovePin(
                pin,
                viewToImage({ x: e.clientX - rect.left, y: e.clientY - rect.top }, base, {
                  scale: view.scale,
                  pan: { x: 0, y: 0 },
                }),
              )
              // A pointer-up after a drag is followed by a click; without this
              // the move would also navigate away from the map.
              suppressClick.current = true
            }}
            // Navigation stays on `click`, not on pointer-up: a keyboard user
            // pressing Enter fires a click and no pointer events at all, and a
            // pin only reachable by mouse is a pin some people cannot follow.
            onClick={() => {
              if (suppressClick.current) {
                suppressClick.current = false
                return
              }
              onOpenPin?.(pin)
            }}
          >
            {pin.label ?? pin.target.name}
          </button>
        ))}
      </div>

      {/* The frame captures the pointer on pointerdown so a drag keeps panning
          even when the cursor leaves it. Under an active capture the browser
          retargets the following click to the CAPTURE element, so a press on a
          control here would never reach the control — the buttons simply did
          nothing, while the keyboard shortcuts worked. Stopping propagation
          keeps the frame from capturing a gesture that began on a control, the
          same treatment the pins already needed. */}
      <div className="map-controls" onPointerDown={(e) => e.stopPropagation()}>
        <Button
          variant="secondary"
          type="button"
          aria-label="Zoom in"
          disabled={view.scale >= MAX_SCALE}
          onClick={() => zoom(ZOOM_STEP)}
        >
          +
        </Button>
        <Button
          variant="secondary"
          type="button"
          aria-label="Zoom out"
          disabled={view.scale <= MIN_SCALE}
          onClick={() => zoom(1 / ZOOM_STEP)}
        >
          −
        </Button>
        <Button variant="secondary" type="button" aria-label="Fit map" onClick={reset}>
          Fit
        </Button>
      </div>
    </div>
  )
}
