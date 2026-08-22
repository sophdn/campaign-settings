import { describe, expect, it } from 'vitest'
import {
  clampPan,
  clampScale,
  fitToViewport,
  imageToView,
  initialView,
  keyboardPanStep,
  MAX_SCALE,
  MIN_SCALE,
  type MapView,
  panBy,
  type Point,
  viewToImage,
  zoomAbout,
} from './map-viewport'

/**
 * The transform pins are placed and read through.
 *
 * A pin is stored as a fraction of the source image and drawn through this
 * conversion at render time, so "the pin holds its position under zoom and pan"
 * is exactly the claim that `viewToImage` inverts `imageToView` at every scale
 * and offset. That is asserted here rather than by eye.
 */

const VIEWPORT = { width: 800, height: 600 }
const BASE = { width: 600, height: 400 }

const near = (a: number, b: number): void => expect(Math.abs(a - b)).toBeLessThan(1e-9)
const nearPoint = (a: Point, b: Point): void => {
  near(a.x, b.x)
  near(a.y, b.y)
}

describe('fitToViewport', () => {
  it('fits a wide source to the viewport width, keeping its aspect ratio', () => {
    // 2:1 into a 4:3 frame is width-bound.
    const fitted = fitToViewport({ width: 2000, height: 1000 }, VIEWPORT)
    expect(fitted).toEqual({ width: 800, height: 400 })
  })

  it('fits a tall source to the viewport height', () => {
    const fitted = fitToViewport({ width: 1000, height: 2000 }, VIEWPORT)
    expect(fitted).toEqual({ width: 300, height: 600 })
  })

  it('scales a small source UP to fill the frame rather than leaving it tiny', () => {
    expect(fitToViewport({ width: 100, height: 75 }, VIEWPORT)).toEqual({ width: 800, height: 600 })
  })

  it('falls back to the viewport for a source with unknown dimensions', () => {
    // A legacy imported map may carry null source dimensions. Showing it
    // stretched beats collapsing it to a zero-sized void.
    expect(fitToViewport({ width: 0, height: 0 }, VIEWPORT)).toEqual(VIEWPORT)
    expect(fitToViewport({ width: -1, height: 10 }, VIEWPORT)).toEqual(VIEWPORT)
  })
})

describe('clampScale', () => {
  it('holds zoom inside its bounds', () => {
    expect(clampScale(0.1)).toBe(MIN_SCALE)
    expect(clampScale(1000)).toBe(MAX_SCALE)
    expect(clampScale(3)).toBe(3)
  })

  it('never returns a scale that would invert or vanish the image', () => {
    // A negative scale mirrors the map and sends every pin to the wrong side of
    // it; a zero scale divides by nothing in the inverse transform.
    for (const bad of [0, -1, -0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(clampScale(bad)).toBeGreaterThanOrEqual(MIN_SCALE)
      expect(clampScale(bad)).toBeLessThanOrEqual(MAX_SCALE)
    }
  })
})

describe('clampPan', () => {
  it('centres the content on an axis where it is smaller than the viewport', () => {
    const pan = clampPan({ x: 9999, y: -9999 }, BASE, VIEWPORT, 1)
    expect(pan).toEqual({ x: 100, y: 100 })
  })

  it('never lets a zoomed image be dragged away from its own edges', () => {
    // At scale 2 the content is 1200×800 inside an 800×600 frame, so the valid
    // offsets run from -400..0 horizontally and -200..0 vertically.
    expect(clampPan({ x: 500, y: 500 }, BASE, VIEWPORT, 2)).toEqual({ x: 0, y: 0 })
    expect(clampPan({ x: -5000, y: -5000 }, BASE, VIEWPORT, 2)).toEqual({ x: -400, y: -200 })
    expect(clampPan({ x: -100, y: -50 }, BASE, VIEWPORT, 2)).toEqual({ x: -100, y: -50 })
  })

  it('always leaves the image overlapping the viewport', () => {
    // The whole point: there is no reachable state where the map is off-screen
    // and the DM is looking at an empty frame with no way back.
    for (const scale of [1, 1.5, 3, MAX_SCALE]) {
      for (const attempt of [
        { x: 1e6, y: 1e6 },
        { x: -1e6, y: -1e6 },
        { x: 0, y: -1e6 },
      ]) {
        const pan = clampPan(attempt, BASE, VIEWPORT, scale)
        const right = pan.x + BASE.width * scale
        const bottom = pan.y + BASE.height * scale
        expect(right).toBeGreaterThan(0)
        expect(bottom).toBeGreaterThan(0)
        expect(pan.x).toBeLessThan(VIEWPORT.width)
        expect(pan.y).toBeLessThan(VIEWPORT.height)
      }
    }
  })
})

describe('initialView', () => {
  it('opens fitted and centred', () => {
    const view = initialView(BASE, VIEWPORT)
    expect(view.scale).toBe(MIN_SCALE)
    expect(view.pan).toEqual({ x: 100, y: 100 })
  })
})

describe('imageToView / viewToImage', () => {
  const views: MapView[] = [
    { scale: 1, pan: { x: 100, y: 100 } },
    { scale: 2, pan: { x: -250, y: -120 } },
    { scale: 4.5, pan: { x: -1000, y: -700 } },
    { scale: MAX_SCALE, pan: { x: -3000, y: -1800 } },
  ]
  const points: Point[] = [
    { x: 0, y: 0 },
    { x: 1, y: 1 },
    { x: 0.5, y: 0.5 },
    { x: 0.137, y: 0.892 },
    { x: 0.999, y: 0.001 },
  ]

  it('places a normalized point at the expected pixel', () => {
    // Centre of the image, fitted and centred in the frame → centre of the frame.
    nearPoint(imageToView({ x: 0.5, y: 0.5 }, BASE, views[0] as MapView), { x: 400, y: 300 })
    // Top-left of the image sits exactly at the pan offset, by definition.
    nearPoint(imageToView({ x: 0, y: 0 }, BASE, views[1] as MapView), { x: -250, y: -120 })
  })

  it('round-trips every point back to itself at every scale and offset', () => {
    // The load-bearing property. If this fails, a pin drifts off the feature it
    // marks as soon as the map is zoomed.
    for (const view of views) {
      for (const n of points) {
        nearPoint(viewToImage(imageToView(n, BASE, view), BASE, view), n)
      }
    }
  })

  it('round-trips in the other direction too, for pixels inside the image', () => {
    const view = views[1] as MapView
    for (const p of [
      { x: 0, y: 0 },
      { x: 400, y: 300 },
      { x: 700, y: 500 },
    ]) {
      nearPoint(imageToView(viewToImage(p, BASE, view), BASE, view), p)
    }
  })

  it('clamps a click outside the image to the edge rather than out of range', () => {
    // `map_pins` CHECKs x and y into 0..1, so an unclamped value would surface
    // as a constraint violation the DM cannot interpret. An edge pin is the
    // honest interpretation of a click just past the edge.
    const view = views[0] as MapView
    expect(viewToImage({ x: -500, y: -500 }, BASE, view)).toEqual({ x: 0, y: 0 })
    expect(viewToImage({ x: 5000, y: 5000 }, BASE, view)).toEqual({ x: 1, y: 1 })
  })

  it('survives a degenerate base size without producing NaN', () => {
    const view = { scale: 1, pan: { x: 0, y: 0 } }
    expect(viewToImage({ x: 10, y: 10 }, { width: 0, height: 0 }, view)).toEqual({ x: 0, y: 0 })
  })
})

describe('zoomAbout', () => {
  it('holds the focused point in place while the scale changes', () => {
    // Zooming about the cursor is what makes a map navigable: the thing you are
    // pointing at is the thing you get closer to.
    const view = { scale: 2, pan: { x: -200, y: -150 } }
    const focus = { x: 350, y: 275 }
    const before = viewToImage(focus, BASE, view)

    const zoomed = zoomAbout(view, BASE, VIEWPORT, focus, 1.4)
    expect(zoomed.scale).toBeCloseTo(2.8)
    nearPoint(viewToImage(focus, BASE, zoomed), before)
  })

  it('holds the focused point on the way back out as well', () => {
    const view = { scale: 4, pan: { x: -900, y: -600 } }
    const focus = { x: 500, y: 200 }
    const before = viewToImage(focus, BASE, view)

    const out = zoomAbout(view, BASE, VIEWPORT, focus, 1 / 1.4)
    nearPoint(viewToImage(focus, BASE, out), before)
  })

  it('stops at the bounds instead of running away', () => {
    const fitted = initialView(BASE, VIEWPORT)
    const outPastFloor = zoomAbout(fitted, BASE, VIEWPORT, { x: 400, y: 300 }, 0.5)
    expect(outPastFloor.scale).toBe(MIN_SCALE)

    let deep: MapView = fitted
    for (let i = 0; i < 30; i++) deep = zoomAbout(deep, BASE, VIEWPORT, { x: 400, y: 300 }, 1.4)
    expect(deep.scale).toBe(MAX_SCALE)
  })

  it('returns the view untouched when it is already at a bound', () => {
    // Not merely cosmetic: recomputing the pan for a scale change that cannot
    // happen would drift the map sideways every time the button is pressed.
    const fitted = initialView(BASE, VIEWPORT)
    expect(zoomAbout(fitted, BASE, VIEWPORT, { x: 0, y: 0 }, 0.5)).toBe(fitted)
  })

  it('keeps the image on screen even when the focus is at the very corner', () => {
    const view = { scale: 3, pan: { x: -500, y: -300 } }
    const zoomed = zoomAbout(view, BASE, VIEWPORT, { x: 0, y: 0 }, 1 / 3)
    expect(zoomed.pan).toEqual(clampPan(zoomed.pan, BASE, VIEWPORT, zoomed.scale))
  })

  it('leaves a fully zoomed-out map centred no matter where it is focused', () => {
    for (const focus of [
      { x: 0, y: 0 },
      { x: 800, y: 600 },
      { x: 400, y: 300 },
    ]) {
      const view = zoomAbout({ scale: 2, pan: { x: -300, y: -200 } }, BASE, VIEWPORT, focus, 0.25)
      expect(view.scale).toBe(MIN_SCALE)
      expect(view.pan).toEqual({ x: 100, y: 100 })
    }
  })
})

describe('panBy', () => {
  it('translates the content and clamps the result', () => {
    const view = { scale: 2, pan: { x: -200, y: -150 } }
    expect(panBy(view, BASE, VIEWPORT, { x: 50, y: 25 }).pan).toEqual({ x: -150, y: -125 })
    // A drag that would tear the image off-screen stops at the edge instead.
    expect(panBy(view, BASE, VIEWPORT, { x: 5000, y: 5000 }).pan).toEqual({ x: 0, y: 0 })
  })

  it('cannot move a fitted map at all, because there is nowhere for it to go', () => {
    const fitted = initialView(BASE, VIEWPORT)
    expect(panBy(fitted, BASE, VIEWPORT, { x: 300, y: 300 }).pan).toEqual(fitted.pan)
  })

  it('leaves the scale alone', () => {
    const view = { scale: 3.5, pan: { x: -400, y: -300 } }
    expect(panBy(view, BASE, VIEWPORT, { x: 10, y: 10 }).scale).toBe(3.5)
  })

  it('keeps a pin anchored to the same image point through a pan', () => {
    const view = { scale: 2, pan: { x: -200, y: -150 } }
    const pin = { x: 0.3, y: 0.7 }
    const before = imageToView(pin, BASE, view)
    const moved = panBy(view, BASE, VIEWPORT, { x: -60, y: -40 })
    const after = imageToView(pin, BASE, moved)
    // The pin moves with the map by exactly the pan delta — it does not slide
    // across it.
    nearPoint(after, { x: before.x - 60, y: before.y - 40 })
  })
})

describe('keyboardPanStep', () => {
  it('scales with the viewport so the feel is the same on any screen', () => {
    expect(keyboardPanStep({ width: 800, height: 600 })).toBe(120)
    expect(keyboardPanStep({ width: 400, height: 300 })).toBe(60)
  })

  it('never degenerates to a step too small to move anything', () => {
    expect(keyboardPanStep({ width: 20, height: 10 })).toBeGreaterThanOrEqual(24)
  })
})
