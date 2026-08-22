import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeThumbnail, THUMBNAIL_BOX } from './thumbnail'

/**
 * jsdom has no image decoder and no canvas encoder, so both seams are stubbed.
 * What is under test is the DECISION logic — when to produce a thumbnail, when
 * to decline, and what geometry to ask the canvas for — not the browser's
 * rasteriser.
 *
 * Every "decline" path resolves to null rather than throwing, because a missing
 * thumbnail is a legal outcome the server and the raw route already handle.
 */

interface StubCanvas {
  width: number
  height: number
  getContext: () => { drawImage: () => void } | null
  toBlob: (cb: (b: Blob | null) => void, type?: string, quality?: number) => void
}

function stubCanvas(over: Partial<StubCanvas> = {}): StubCanvas {
  const canvas: StubCanvas = {
    width: 0,
    height: 0,
    getContext: () => ({ drawImage: () => {} }),
    toBlob: (cb) => cb(new Blob(['thumb'], { type: 'image/jpeg' })),
    ...over,
  }
  vi.spyOn(document, 'createElement').mockReturnValue(canvas as unknown as HTMLElement)
  return canvas
}

/** Stub the decoder with a bitmap of the given intrinsic size. */
function stubDecoder(bitmap: { width: number; height: number } | null): { closed: boolean } {
  const state = { closed: false }
  vi.stubGlobal(
    'createImageBitmap',
    bitmap === null
      ? (): Promise<never> => Promise.reject(new Error('not decodable'))
      : (): Promise<unknown> => Promise.resolve({ ...bitmap, close: () => (state.closed = true) }),
  )
  return state
}

const anyBlob = (): Blob => new Blob(['bytes'], { type: 'image/png' })

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('makeThumbnail', () => {
  it('downscales a large image to fit the box, keeping its aspect ratio', async () => {
    stubDecoder({ width: 4000, height: 2000 })
    const canvas = stubCanvas()

    const out = await makeThumbnail(anyBlob())

    expect(out).not.toBeNull()
    // The LONG edge lands on the box; the short edge follows the ratio, so a
    // panoramic map is not squashed into a square.
    expect(canvas.width).toBe(THUMBNAIL_BOX)
    expect(canvas.height).toBe(THUMBNAIL_BOX / 2)
  })

  it('fits the box to the taller edge for a portrait image', async () => {
    stubDecoder({ width: 1000, height: 3000 })
    const canvas = stubCanvas()

    await makeThumbnail(anyBlob())

    expect(canvas.height).toBe(THUMBNAIL_BOX)
    expect(canvas.width).toBe(Math.round(THUMBNAIL_BOX / 3))
  })

  it('encodes as JPEG, which is what the server serves thumbnails as', async () => {
    stubDecoder({ width: 2000, height: 2000 })
    let requestedType: string | undefined
    stubCanvas({
      toBlob: (cb, type) => {
        requestedType = type
        cb(new Blob(['t'], { type: 'image/jpeg' }))
      },
    })

    await makeThumbnail(anyBlob())
    expect(requestedType).toBe('image/jpeg')
  })

  it('declines for an image already inside the box', async () => {
    // A "thumbnail" larger than its source is the opposite of the point, and
    // re-encoding an already-small image only loses quality.
    stubDecoder({ width: 100, height: 100 })
    stubCanvas()

    expect(await makeThumbnail(anyBlob())).toBeNull()
  })

  it('declines for an image exactly the size of the box', async () => {
    stubDecoder({ width: THUMBNAIL_BOX, height: THUMBNAIL_BOX })
    stubCanvas()

    expect(await makeThumbnail(anyBlob())).toBeNull()
  })

  it('never produces a zero-width canvas for an extreme aspect ratio', async () => {
    // A 10000×1 strip scales to a sub-pixel height; a canvas of height 0 throws
    // in a real browser, which would take the whole upload down with it.
    stubDecoder({ width: 10_000, height: 1 })
    const canvas = stubCanvas()

    await makeThumbnail(anyBlob())
    expect(canvas.height).toBeGreaterThanOrEqual(1)
    expect(canvas.width).toBeGreaterThanOrEqual(1)
  })

  it('declines rather than throwing when the bytes are not decodable', async () => {
    stubDecoder(null)
    expect(await makeThumbnail(anyBlob())).toBeNull()
  })

  it('declines when the browser has no createImageBitmap at all', async () => {
    vi.stubGlobal('createImageBitmap', undefined)
    expect(await makeThumbnail(anyBlob())).toBeNull()
  })

  it('declines when a 2D context cannot be obtained', async () => {
    stubDecoder({ width: 2000, height: 2000 })
    stubCanvas({ getContext: () => null })

    expect(await makeThumbnail(anyBlob())).toBeNull()
  })

  it('declines when the encoder hands back nothing', async () => {
    stubDecoder({ width: 2000, height: 2000 })
    stubCanvas({ toBlob: (cb) => cb(null) })

    expect(await makeThumbnail(anyBlob())).toBeNull()
  })

  it('releases the decoded bitmap even when it declines to produce a thumbnail', async () => {
    // A full-size decoded bitmap is the largest thing this path allocates.
    // Holding one per picked file is how a DM who browses ten maps runs out of
    // memory on a phone.
    const state = stubDecoder({ width: 50, height: 50 }) // too small → declines
    stubCanvas()

    await makeThumbnail(anyBlob())
    expect(state.closed).toBe(true)
  })
})
