/**
 * Downscale a picked image in the browser, so the server never needs an image
 * pipeline.
 *
 * The server has no way to resize anything — Node has no canvas, and the
 * alternative was a native-binary dependency in a package that has eight. The
 * browser already has a decoder and a rasteriser, and this is the one place in
 * the app where a big image is sitting in memory next to both of them.
 *
 * The result is a suggestion, not a credential. Whatever comes back here is
 * re-identified and re-capped server-side exactly like any other upload, because
 * "the client generated it" is not a security property — it only means that a
 * member who could have uploaded a misleading source could also upload a
 * misleading preview, which is a thing they were always able to do.
 */

/** Longest edge of a generated thumbnail, in CSS pixels. */
export const THUMBNAIL_BOX = 512

/** JPEG quality — visibly clean at gallery size, comfortably inside the cap. */
const THUMBNAIL_QUALITY = 0.82

/**
 * A JPEG preview of `file`, bounded to a {@link THUMBNAIL_BOX} square with the
 * aspect ratio kept, or `null` when the browser cannot produce one.
 *
 * Null is a normal outcome, not an error: an attachment with no thumbnail is a
 * legal state that the raw route handles by serving the source. So a decode
 * failure, a missing 2D context, or an image already smaller than the box all
 * resolve the same quiet way — the upload still succeeds, it just has no
 * separate preview.
 */
export async function makeThumbnail(file: Blob): Promise<Blob | null> {
  const bitmap = await decode(file)
  if (!bitmap) return null
  try {
    const scale = Math.min(THUMBNAIL_BOX / bitmap.width, THUMBNAIL_BOX / bitmap.height)
    // An image already inside the box gains nothing from being re-encoded; a
    // thumbnail LARGER than its source would be the opposite of the point.
    if (scale >= 1) return null

    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(bitmap.width * scale))
    canvas.height = Math.max(1, Math.round(bitmap.height * scale))
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    return await toJpegBlob(canvas)
  } finally {
    bitmap.close?.()
  }
}

/** A decoded bitmap, or null if these bytes are not an image this browser reads. */
async function decode(file: Blob): Promise<(ImageBitmap & { close?: () => void }) | null> {
  if (typeof createImageBitmap !== 'function') return null
  try {
    return await createImageBitmap(file)
  } catch {
    // Not decodable here. The server will refuse it too if it is genuinely not
    // an image; if it merely is not decodable in THIS browser, the upload still
    // works and simply has no preview.
    return null
  }
}

function toJpegBlob(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => {
    // toBlob hands back null rather than throwing when encoding fails, and the
    // callback signature is the only form jsdom and every browser agree on.
    canvas.toBlob((blob) => resolve(blob), 'image/jpeg', THUMBNAIL_QUALITY)
  })
}
