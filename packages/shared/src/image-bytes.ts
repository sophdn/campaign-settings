/**
 * Raster-image identification straight from the bytes: what format is this, and
 * how big is it? Pure and sans-IO, so the upload path can decide what it has
 * before writing anything, and both sides of the wire can share one answer.
 *
 * The filename, the extension, and the client-declared Content-Type are all
 * attacker-controlled, and none of them is evidence of what a file contains. The
 * header is. Everything here reads the header and nothing else.
 *
 * Dimensions come from the header too, without decoding a single pixel — which
 * is what lets a Node server record a map's source size with no image library
 * and no native dependency. Map pins are stored as fractions of the source, so
 * `source_width`/`source_height` are not decoration: they are what a normalized
 * coordinate is normalized AGAINST.
 *
 * Ported from dm-manager (`services/storage/media.ts` +
 * `services/storage/image-processor.ts`), which reached the same place from the
 * same constraint.
 */

/** The raster formats this app accepts. Anything else is refused at the door. */
export const IMAGE_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const

export type ImageMimeType = (typeof IMAGE_MIME_TYPES)[number]

/**
 * The closed set of roles an attachment can play. Every one of them is a raster
 * image — `media_kind` names what the file is FOR, not what format it is in.
 *
 * - `image` — a picture attached to an entity, shown in its gallery.
 * - `map`   — the image a map displays, which pins are positioned against.
 *
 * **Images only, decided 2026-08-08 (Sophi).** The original design left this
 * open for portraits, handouts, audio and PDFs, and the column was free text
 * with nothing enforcing it — an open vocabulary that no code could rely on and
 * no reader could trust. The campaign use case is served by images, so the set
 * is closed here instead, and every stored file goes through the magic-byte
 * check above.
 *
 * Reopening it is a real piece of work, not a new string: a non-image kind needs
 * its own byte-level detector (never the declared type), its own size ceiling,
 * and a serve path that cannot be turned into stored XSS — `Content-Disposition`
 * and a restrictive CSP on the raw route, which images do not need because a
 * browser will not script a decoded JPEG. Add those together or not at all.
 */
export const MEDIA_KINDS = ['image', 'map'] as const

export type MediaKind = (typeof MEDIA_KINDS)[number]

export function isMediaKind(value: string): value is MediaKind {
  return (MEDIA_KINDS as readonly string[]).includes(value)
}

export interface ImageDimensions {
  width: number
  height: number
}

/**
 * The mime type these bytes actually are, or `null` if they are not a raster
 * image this app accepts. Reads magic bytes only — a `.png` full of PDF, or a
 * JPEG announced as `image/webp`, both resolve to what they really are.
 */
export function detectImageMime(bytes: Uint8Array): ImageMimeType | null {
  if (isJpeg(bytes)) return 'image/jpeg'
  if (isPng(bytes)) return 'image/png'
  if (isWebp(bytes)) return 'image/webp'
  return null
}

/** The file extension a stored image gets, derived from its DETECTED mime. */
export function extensionForImageMime(mime: ImageMimeType): string {
  switch (mime) {
    case 'image/jpeg':
      return '.jpg'
    case 'image/png':
      return '.png'
    case 'image/webp':
      return '.webp'
  }
}

/**
 * `{width, height}` read from the image header, or `null` for bytes that are not
 * a supported image or whose header is truncated. Covers PNG, JPEG, and all
 * three WebP chunk variants (VP8 lossy / VP8L lossless / VP8X extended).
 */
export function readImageDimensions(bytes: Uint8Array): ImageDimensions | null {
  return readPngDimensions(bytes) ?? readJpegDimensions(bytes) ?? readWebpDimensions(bytes)
}

// ── magic-byte detectors ────────────────────────────────────────────────────

function isJpeg(b: Uint8Array): boolean {
  return b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const

function isPng(b: Uint8Array): boolean {
  return b.length >= 8 && PNG_SIGNATURE.every((byte, i) => b[i] === byte)
}

function isWebp(b: Uint8Array): boolean {
  // "RIFF" at 0, "WEBP" at 8 — the four bytes between are the chunk length.
  return b.length >= 12 && matchesAscii(b, 0, 'RIFF') && matchesAscii(b, 8, 'WEBP')
}

/** Whether the bytes at `offset` spell `text` in ASCII. */
function matchesAscii(b: Uint8Array, offset: number, text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    if (b[offset + i] !== text.charCodeAt(i)) return false
  }
  return true
}

// ── header dimension readers ────────────────────────────────────────────────

/** PNG: 8-byte signature, then IHDR with width @16 and height @20 (uint32 BE). */
function readPngDimensions(b: Uint8Array): ImageDimensions | null {
  if (!isPng(b) || b.length < 24) return null
  return { width: readUint32BE(b, 16), height: readUint32BE(b, 20) }
}

/**
 * JPEG: walk the segment chain to the Start-Of-Frame marker, which is the only
 * one carrying the frame size. A JPEG is a sequence of `ff <marker> <length>`
 * segments, so the dimensions are not at a fixed offset the way PNG's are.
 */
function readJpegDimensions(b: Uint8Array): ImageDimensions | null {
  if (!isJpeg(b)) return null
  let offset = 2 // past the ffd8 Start-Of-Image marker
  // A SOF segment is 9 bytes before its payload, so anything shorter is truncated.
  while (offset + 9 < b.length) {
    if (b[offset] !== 0xff) {
      // Padding between segments is legal; step over it rather than giving up.
      offset++
      continue
    }
    // In range by the loop guard above, so read it rather than defaulting it.
    const marker = view(b).getUint8(offset + 1)
    if (isStartOfFrame(marker)) {
      // Height precedes width in a SOF header, which is the opposite of PNG.
      return { height: readUint16BE(b, offset + 5), width: readUint16BE(b, offset + 7) }
    }
    const segmentLength = readUint16BE(b, offset + 2)
    // A length below 2 cannot include its own two length bytes: malformed, and
    // trusting it would step backwards and loop forever.
    if (segmentLength < 2) return null
    offset += 2 + segmentLength
  }
  return null
}

/**
 * SOF0..SOF15 carry frame dimensions — except the three markers that share that
 * numeric range without being frame headers (DHT, JPG, DAC).
 */
function isStartOfFrame(marker: number): boolean {
  return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
}

/** WebP: the size lives in the first chunk, whose layout depends on its FourCC. */
function readWebpDimensions(b: Uint8Array): ImageDimensions | null {
  if (!isWebp(b) || b.length < 30) return null
  if (matchesAscii(b, 12, 'VP8 ')) {
    // Lossy: 14-bit width/height at 26/28, little-endian, top two bits are scale.
    return { width: readUint16LE(b, 26) & 0x3fff, height: readUint16LE(b, 28) & 0x3fff }
  }
  if (matchesAscii(b, 12, 'VP8L')) {
    // Lossless: width-1 and height-1 packed as two 14-bit fields from offset 21.
    const bits = readUint32LE(b, 21)
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }
  }
  if (matchesAscii(b, 12, 'VP8X')) {
    // Extended: canvas width-1 / height-1 as 24-bit LE at 24 and 27.
    return { width: readUint24LE(b, 24) + 1, height: readUint24LE(b, 27) + 1 }
  }
  return null
}

// ── byte readers ────────────────────────────────────────────────────────────
//
// A DataView rather than per-byte indexing: it reads each multi-byte integer
// directly, in the endianness the format specifies. Hand-rolled shifting needed
// a `?? 0` on every byte to satisfy the compiler about an index that cannot be
// out of range — each caller length-checks its header first — and every one of
// those fallbacks was a branch that could never be taken.

const view = (b: Uint8Array): DataView => new DataView(b.buffer, b.byteOffset, b.byteLength)

const readUint16BE = (b: Uint8Array, o: number): number => view(b).getUint16(o, false)

const readUint32BE = (b: Uint8Array, o: number): number => view(b).getUint32(o, false)

const readUint16LE = (b: Uint8Array, o: number): number => view(b).getUint16(o, true)

const readUint32LE = (b: Uint8Array, o: number): number => view(b).getUint32(o, true)

/** 24-bit little-endian — WebP's extended canvas size, which has no native getter. */
function readUint24LE(b: Uint8Array, o: number): number {
  const v = view(b)
  return v.getUint16(o, true) | (v.getUint8(o + 2) << 16)
}
