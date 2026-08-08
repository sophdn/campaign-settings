import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MapPin, WorldMap } from '../api'
import { MapViewer } from './map-viewer'
import { MIN_SCALE } from './map-viewport'

/**
 * The DOM half of the viewer. The arithmetic has its own suite
 * (`map-viewport.test.ts`) and is not re-tested here; what these assert is the
 * wiring — that a click becomes a NORMALIZED coordinate, that pins are
 * positioned as percentages of the content layer, and that the keyboard reaches
 * everything the pointer does.
 */

const MAP: WorldMap = {
  id: 'map1',
  world_id: 'w1',
  name: 'Saltmarsh',
  description: '',
  visibility: 'public',
  source_width: 1000,
  source_height: 500,
  created_at: '2026-01-01',
}

const pin = (over: Partial<MapPin> = {}): MapPin => ({
  id: 'pin1',
  map_id: 'map1',
  entity_id: 'e1',
  x: 0.25,
  y: 0.5,
  label: null,
  target: { kind: 'npc', id: 'e1', name: 'The Harbourmaster' },
  ...over,
})

/**
 * jsdom gives every element a zero-sized bounding box, so the viewer would
 * measure a 0×0 viewport and refuse to draw. Fix the frame at a known size, and
 * the transform's numbers become predictable.
 */
const FRAME = { width: 800, height: 600 }

/** Callbacks registered by the component's ResizeObserver, so a test can fire them. */
let resizeCallbacks: (() => void)[] = []

/** Re-measure the frame at a new size and tell the component about it. */
function resizeFrameTo(size: { width: number; height: number }): void {
  mockFrameRect(size)
  act(() => {
    for (const cb of resizeCallbacks) cb()
  })
}

function mockFrameRect(size: { width: number; height: number }): void {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: size.width,
    bottom: size.height,
    ...size,
    toJSON: () => ({}),
  } as DOMRect)
}

beforeEach(() => {
  resizeCallbacks = []
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(cb: () => void) {
        resizeCallbacks.push(cb)
      }
      observe(): void {}
      disconnect(): void {}
    },
  )
  mockFrameRect(FRAME)
  // jsdom implements neither, and the viewer calls both on pointer down.
  HTMLElement.prototype.setPointerCapture = (): void => {}
  HTMLElement.prototype.releasePointerCapture = (): void => {}
})

const content = (): HTMLElement => screen.getByTestId('map-content')
const frame = (): HTMLElement => screen.getByTestId('map-frame')

describe('MapViewer', () => {
  it('says what to do instead of drawing an empty frame when there is no image', () => {
    render(<MapViewer map={MAP} imageUrl={null} pins={[]} />)
    expect(screen.getByText(/Upload one to start placing pins/)).toBeTruthy()
    expect(screen.queryByTestId('map-content')).toBeNull()
  })

  it('fits the image to the frame, keeping its aspect ratio', () => {
    render(<MapViewer map={MAP} imageUrl="/img" pins={[]} />)
    // A 2:1 source in a 4:3 frame is width-bound: 800×400, centred vertically.
    expect(content().style.width).toBe('800px')
    expect(content().style.height).toBe('400px')
    expect(content().style.top).toBe('100px')
  })

  it('positions each pin as a percentage of the content layer', () => {
    // This is what makes a pin track zoom and pan without any code running: the
    // browser moves it with the layer.
    render(<MapViewer map={MAP} imageUrl="/img" pins={[pin()]} />)
    const marker = screen.getByRole('button', { name: 'The Harbourmaster' })
    expect(marker.style.left).toBe('25%')
    expect(marker.style.top).toBe('50%')
  })

  it('prefers a pin’s own label over its target’s name when one is set', () => {
    render(<MapViewer map={MAP} imageUrl="/img" pins={[pin({ label: 'The docks' })]} />)
    expect(screen.getByRole('button', { name: 'The docks' })).toBeTruthy()
  })

  it('lets a control be pressed without the frame capturing the gesture', () => {
    // The frame captures the pointer so a drag keeps panning off-element. Under
    // an active capture the browser retargets the click to the capture element,
    // so without stopping propagation here the zoom buttons do nothing at all —
    // a failure jsdom cannot reproduce, because it does not implement capture.
    const captured: number[] = []
    HTMLElement.prototype.setPointerCapture = function (id: number): void {
      captured.push(id)
    }
    render(<MapViewer map={MAP} imageUrl="/img" pins={[]} />)

    fireEvent.pointerDown(screen.getByRole('button', { name: 'Zoom in' }), { pointerId: 7 })
    expect(captured).not.toContain(7)
  })

  it('grows the content layer on zoom in, and returns it to fitted on Fit', () => {
    render(<MapViewer map={MAP} imageUrl="/img" pins={[]} />)
    const fittedWidth = content().style.width

    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }))
    expect(parseFloat(content().style.width)).toBeGreaterThan(parseFloat(fittedWidth))

    fireEvent.click(screen.getByRole('button', { name: 'Fit map' }))
    expect(content().style.width).toBe(fittedWidth)
  })

  it('disables zoom-out at the fitted floor and zoom-in at the ceiling', () => {
    render(<MapViewer map={MAP} imageUrl="/img" pins={[]} />)
    expect(screen.getByRole('button', { name: 'Zoom out' })).toHaveProperty('disabled', true)

    for (let i = 0; i < 20; i++) fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }))
    expect(screen.getByRole('button', { name: 'Zoom in' })).toHaveProperty('disabled', true)

    // …and the way back is still open, so the ceiling is not a dead end.
    const atCeiling = content().style.width
    expect(screen.getByRole('button', { name: 'Zoom out' })).toHaveProperty('disabled', false)
    fireEvent.click(screen.getByRole('button', { name: 'Zoom out' }))
    expect(parseFloat(content().style.width)).toBeLessThan(parseFloat(atCeiling))
  })

  it('reports a click as a NORMALIZED image coordinate, not a screen position', () => {
    const onPlace = vi.fn()
    render(<MapViewer map={MAP} imageUrl="/img" pins={[]} onPlace={onPlace} />)

    // Content is 800×400 at top 100. A click at (200, 200) is a fifth across
    // and a quarter down the IMAGE — which is what the database stores, and what
    // survives every later zoom.
    fireEvent.pointerDown(frame(), { pointerId: 1, clientX: 200, clientY: 200 })
    fireEvent.pointerUp(frame(), { pointerId: 1, clientX: 200, clientY: 200 })

    expect(onPlace).toHaveBeenCalledTimes(1)
    const at = onPlace.mock.calls[0]?.[0] as { x: number; y: number }
    expect(at.x).toBeCloseTo(0.25)
    expect(at.y).toBeCloseTo(0.25)
  })

  it('treats a drag as a pan, not as a placement', () => {
    // Otherwise every attempt to move the map would drop a pin on it.
    const onPlace = vi.fn()
    render(<MapViewer map={MAP} imageUrl="/img" pins={[]} onPlace={onPlace} />)
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' })) // pan needs slack

    fireEvent.pointerDown(frame(), { pointerId: 1, clientX: 400, clientY: 300 })
    fireEvent.pointerMove(frame(), { pointerId: 1, clientX: 340, clientY: 260 })
    fireEvent.pointerUp(frame(), { pointerId: 1, clientX: 340, clientY: 260 })

    expect(onPlace).not.toHaveBeenCalled()
  })

  it('does not report placements when placement mode is off', () => {
    const onPlace = vi.fn()
    render(<MapViewer map={MAP} imageUrl="/img" pins={[]} onPlace={null} />)
    fireEvent.pointerDown(frame(), { pointerId: 1, clientX: 200, clientY: 200 })
    fireEvent.pointerUp(frame(), { pointerId: 1, clientX: 200, clientY: 200 })
    expect(onPlace).not.toHaveBeenCalled()
  })

  it('opens the entity a pin marks without also treating the click as a placement', () => {
    const onOpenPin = vi.fn()
    const onPlace = vi.fn()
    render(
      <MapViewer
        map={MAP}
        imageUrl="/img"
        pins={[pin()]}
        onPlace={onPlace}
        onOpenPin={onOpenPin}
      />,
    )
    const marker = screen.getByRole('button', { name: 'The Harbourmaster' })
    fireEvent.pointerDown(marker, { pointerId: 1 })
    fireEvent.click(marker)

    expect(onOpenPin).toHaveBeenCalledWith(pin())
    expect(onPlace).not.toHaveBeenCalled()
  })

  it('pans and zooms from the keyboard', () => {
    // A map that can only be explored by dragging is a map some people cannot
    // explore at all.
    render(<MapViewer map={MAP} imageUrl="/img" pins={[]} />)
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }))
    const before = content().style.left

    fireEvent.keyDown(frame(), { key: 'ArrowRight' })
    expect(content().style.left).not.toBe(before)

    const zoomed = content().style.width
    fireEvent.keyDown(frame(), { key: '+' })
    expect(parseFloat(content().style.width)).toBeGreaterThan(parseFloat(zoomed))
    fireEvent.keyDown(frame(), { key: '-' })
    expect(parseFloat(content().style.width)).toBeCloseTo(parseFloat(zoomed), 1)
  })

  it('resets to fitted on the 0 key', () => {
    render(<MapViewer map={MAP} imageUrl="/img" pins={[]} />)
    const fittedWidth = content().style.width
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }))
    fireEvent.keyDown(frame(), { key: '0' })
    expect(content().style.width).toBe(fittedWidth)
  })

  it('ignores keys it does not handle, leaving the page shortcuts alone', () => {
    render(<MapViewer map={MAP} imageUrl="/img" pins={[]} />)
    const before = { left: content().style.left, width: content().style.width }
    fireEvent.keyDown(frame(), { key: 'a' })
    expect(content().style.left).toBe(before.left)
    expect(content().style.width).toBe(before.width)
  })

  it('zooms on a wheel notch and stops the page scrolling underneath', () => {
    render(<MapViewer map={MAP} imageUrl="/img" pins={[]} />)
    const fitted = content().style.width

    // Attached natively rather than through React, because a React wheel
    // handler is passive and cannot preventDefault — the page would scroll
    // while the map zoomed.
    const event = new WheelEvent('wheel', {
      deltaY: -100,
      clientX: 400,
      clientY: 300,
      cancelable: true,
      bubbles: true,
    })
    // Dispatched raw rather than through fireEvent because the handler is a
    // NATIVE listener; act() is what lets React flush the state change it makes.
    act(() => {
      frame().dispatchEvent(event)
    })

    expect(event.defaultPrevented).toBe(true)
    expect(parseFloat(content().style.width)).toBeGreaterThan(parseFloat(fitted))

    const zoomed = content().style.width
    act(() => {
      frame().dispatchEvent(
        new WheelEvent('wheel', { deltaY: 100, clientX: 400, clientY: 300, cancelable: true }),
      )
    })
    expect(parseFloat(content().style.width)).toBeLessThan(parseFloat(zoomed))
  })

  it('abandons a drag that the browser cancels', () => {
    // A cancelled pointer (a system gesture taking over, the window losing
    // focus) must not leave a half-finished drag that the next click completes
    // as a stray placement.
    const onPlace = vi.fn()
    render(<MapViewer map={MAP} imageUrl="/img" pins={[]} onPlace={onPlace} />)
    fireEvent.pointerDown(frame(), { pointerId: 1, clientX: 200, clientY: 200 })
    fireEvent.pointerCancel(frame(), { pointerId: 1 })
    fireEvent.pointerUp(frame(), { pointerId: 1, clientX: 200, clientY: 200 })
    expect(onPlace).not.toHaveBeenCalled()
  })

  it('ignores pointer movement from a second, uncaptured pointer', () => {
    // A second finger arriving mid-drag would otherwise pan the map by the
    // distance between the two touches.
    render(<MapViewer map={MAP} imageUrl="/img" pins={[]} />)
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }))
    fireEvent.pointerDown(frame(), { pointerId: 1, clientX: 400, clientY: 300 })
    const before = content().style.left
    fireEvent.pointerMove(frame(), { pointerId: 2, clientX: 100, clientY: 100 })
    expect(content().style.left).toBe(before)
  })

  it('keeps the chosen zoom when the surrounding page reflows', () => {
    // Placing a pin adds a list below the map, which changes the frame's
    // measured size. Re-fitting on every measurement threw the DM's zoom away
    // each time that happened — they would zoom in, drop a pin, and find
    // themselves back at fit.
    const { rerender } = render(<MapViewer map={MAP} imageUrl="/img" pins={[]} />)
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }))
    const zoomed = content().style.width

    rerender(<MapViewer map={MAP} imageUrl="/img" pins={[pin()]} />)
    expect(content().style.width).toBe(zoomed)
  })

  it('keeps the zoom and re-clamps the pan when the frame itself changes size', () => {
    // A phone rotating, or the window resizing. The image is the same one, so
    // the DM's zoom survives; only the pan is brought back inside the new
    // bounds. Re-fitting here would reset them to fit every rotation.
    render(<MapViewer map={MAP} imageUrl="/img" pins={[]} />)
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }))
    fireEvent.keyDown(frame(), { key: 'ArrowRight' })
    const scaleBefore = parseFloat(content().style.width) / FRAME.width

    resizeFrameTo({ width: 400, height: 600 })

    // Same zoom factor against the new fitted size, not a reset to 1.
    const fittedNow = 400 // width-bound: a 2:1 source in a 400×600 frame
    expect(parseFloat(content().style.width) / fittedNow).toBeCloseTo(scaleBefore, 5)
    // The pan is inside the new bounds rather than stranded off the old ones.
    const left = parseFloat(content().style.left)
    expect(left).toBeLessThanOrEqual(0)
    expect(left + parseFloat(content().style.width)).toBeGreaterThanOrEqual(400)
  })

  it('DOES re-fit when the image itself changes', () => {
    // A different map is a different thing to look at; carrying the previous
    // map's zoom into it would be arbitrary.
    const { rerender } = render(<MapViewer map={MAP} imageUrl="/img" pins={[]} />)
    const fittedWidth = content().style.width
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }))
    expect(content().style.width).not.toBe(fittedWidth)

    rerender(<MapViewer map={MAP} imageUrl="/other-img" pins={[]} />)
    expect(content().style.width).toBe(fittedWidth)
  })

  it('is reachable by keyboard and announces how to drive it', () => {
    render(<MapViewer map={MAP} imageUrl="/img" pins={[]} />)
    const app = screen.getByRole('application')
    expect(app.getAttribute('tabindex')).toBe('0')
    expect(app.getAttribute('aria-label')).toMatch(/Arrow keys pan/)
  })

  it('still renders a map whose source dimensions were never recorded', () => {
    // A legacy imported map may carry nulls. Stretched beats invisible.
    render(
      <MapViewer
        map={{ ...MAP, source_width: null, source_height: null }}
        imageUrl="/img"
        pins={[]}
      />,
    )
    expect(content().style.width).toBe(`${FRAME.width * MIN_SCALE}px`)
  })
})
