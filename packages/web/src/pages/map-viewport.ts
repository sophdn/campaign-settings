/**
 * The pan/zoom transform a map viewer is built on — pure arithmetic, no DOM.
 *
 * This exists as its own module for the same reason `wiki-graph-layout` does:
 * the property that matters is testable without rendering anything. A pin is
 * stored as a FRACTION of the source image (the `map_pins` CHECK constraints
 * enforce 0..1), so "the pin stays on the same feature at every zoom level" is a
 * statement about the conversion between image space and view space — not about
 * CSS. Written as incidental transform styles it could only be checked by eye.
 *
 * ## The model
 *
 * The content layer — image and pins together — is drawn at `base × scale` and
 * positioned with its top-left at `pan`, in viewport pixels. So a normalized
 * image point `n` sits at `n × base × scale + pan`.
 *
 * Pins are children of that layer, positioned in percentages, which means the
 * browser tracks them through zoom and pan for free. Only two operations need
 * explicit arithmetic: turning a click into a normalized coordinate, and zooming
 * about a fixed point. Both are below.
 */

export interface Point {
  x: number
  y: number
}

export interface Size {
  width: number
  height: number
}

/** A viewer's current transform: how far in, and where the content's corner is. */
export interface MapView {
  scale: number
  pan: Point
}

/**
 * Scale 1 is the whole map fitted in the viewport. Zooming out past it would
 * shrink the map inside a frame it already fits — motion with nothing gained —
 * so it is the floor rather than an arbitrary minimum.
 */
export const MIN_SCALE = 1

/** Eight times fitted. Past this a city map is showing its own pixels. */
export const MAX_SCALE = 8

/** Step per zoom-button press. Roughly six presses from fitted to fully in. */
export const ZOOM_STEP = 1.4

/** Gentler than a button press: a wheel notch should not jump a third of the range. */
export const WHEEL_STEP = 1.15

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v))
const clamp01 = (v: number): number => clamp(v, 0, 1)

/** Zoom held inside its bounds — and never zero or negative, which would invert the image. */
export const clampScale = (scale: number): number =>
  Number.isFinite(scale) ? clamp(scale, MIN_SCALE, MAX_SCALE) : MIN_SCALE

/**
 * The size the source image occupies at scale 1: as large as fits the viewport
 * with its aspect ratio kept (a `contain` fit).
 *
 * A source with no usable dimensions falls back to filling the viewport rather
 * than collapsing to nothing — a legacy imported map may have arrived with null
 * dimensions, and showing it stretched beats showing a zero-sized void.
 */
export function fitToViewport(source: Size, viewport: Size): Size {
  if (source.width <= 0 || source.height <= 0) return { ...viewport }
  const scale = Math.min(viewport.width / source.width, viewport.height / source.height)
  return { width: source.width * scale, height: source.height * scale }
}

/**
 * Keep the content anchored sensibly: centred on any axis where it is smaller
 * than the viewport, and otherwise never dragged past its own edge.
 *
 * This is what makes "the image cannot be lost off-screen" true by construction
 * rather than by a bounds check somewhere in the drag handler. Every function
 * that produces a view runs its result through here, so there is no path to an
 * unclamped one.
 */
export function clampPan(pan: Point, base: Size, viewport: Size, scale: number): Point {
  const axis = (offset: number, content: number, frame: number): number => {
    if (content <= frame) return (frame - content) / 2
    // Content larger than the frame: the left/top edge may not come inboard of
    // the frame's, and the right/bottom edge may not come inboard of its far side.
    return clamp(offset, frame - content, 0)
  }
  return {
    x: axis(pan.x, base.width * scale, viewport.width),
    y: axis(pan.y, base.height * scale, viewport.height),
  }
}

/** The starting view: fitted and centred. */
export function initialView(base: Size, viewport: Size): MapView {
  return { scale: MIN_SCALE, pan: clampPan({ x: 0, y: 0 }, base, viewport, MIN_SCALE) }
}

/**
 * Where a normalized image point lands in the viewport, in pixels.
 *
 * The exact inverse of {@link viewToImage} for any point inside the image, which
 * is what "a pin stays on the same feature" reduces to.
 */
export function imageToView(n: Point, base: Size, view: MapView): Point {
  return {
    x: n.x * base.width * view.scale + view.pan.x,
    y: n.y * base.height * view.scale + view.pan.y,
  }
}

/**
 * The normalized image point under a viewport pixel position.
 *
 * Clamped to the unit square, because this is what turns a click into a stored
 * pin and the `map_pins` CHECK constraints reject anything outside it. A click a
 * few pixels off the edge of the image becomes a pin on the edge rather than a
 * database error the DM cannot interpret.
 */
export function viewToImage(p: Point, base: Size, view: MapView): Point {
  const width = base.width * view.scale
  const height = base.height * view.scale
  if (width <= 0 || height <= 0) return { x: 0, y: 0 }
  return {
    x: clamp01((p.x - view.pan.x) / width),
    y: clamp01((p.y - view.pan.y) / height),
  }
}

/**
 * Scale by `factor` while holding whatever is under `focus` in place.
 *
 * Zooming about the cursor rather than the origin is what makes a map feel
 * navigable: the thing you are pointing at is the thing you get closer to. The
 * viewport centre is passed as the focus for the +/- buttons and for keyboard
 * zoom, where there is no cursor to speak of.
 *
 * The focus is only held exactly while the result needs no clamping — at the
 * edges, keeping the image on screen wins over keeping the cursor anchored.
 */
export function zoomAbout(
  view: MapView,
  base: Size,
  viewport: Size,
  focus: Point,
  factor: number,
): MapView {
  const scale = clampScale(view.scale * factor)
  // Already at a bound: nothing moves, rather than drifting the pan on a zoom
  // that cannot happen.
  if (scale === view.scale) return view
  // Invert content→viewport at the old scale, re-apply at the new one.
  const ratio = scale / view.scale
  const pan = {
    x: focus.x - (focus.x - view.pan.x) * ratio,
    y: focus.y - (focus.y - view.pan.y) * ratio,
  }
  return { scale, pan: clampPan(pan, base, viewport, scale) }
}

/** Translate the content by a viewport-pixel delta, clamped. */
export function panBy(view: MapView, base: Size, viewport: Size, delta: Point): MapView {
  return {
    scale: view.scale,
    pan: clampPan({ x: view.pan.x + delta.x, y: view.pan.y + delta.y }, base, viewport, view.scale),
  }
}

/**
 * How far one arrow-key press moves the content: a fifth of the viewport, so a
 * keyboard user crosses a zoomed map in a handful of presses rather than
 * forty. Scaled to the viewport rather than fixed in pixels, so the feel is the
 * same on a phone and on a desktop.
 */
export function keyboardPanStep(viewport: Size): number {
  return Math.max(24, Math.round(Math.min(viewport.width, viewport.height) / 5))
}
