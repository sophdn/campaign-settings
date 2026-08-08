import { describe, expect, it } from 'vitest'
import {
  detectImageMime,
  extensionForImageMime,
  IMAGE_MIME_TYPES,
  isMediaKind,
  MEDIA_KINDS,
  readImageDimensions,
} from './image-bytes'

/**
 * Header builders. These are real headers, not fixtures — the point of the
 * module under test is that it reads the header, so a test that fed it anything
 * else would be testing nothing. Pixel data is irrelevant to every function
 * here, so none of these carry any.
 */

function png(width: number, height: number): Uint8Array {
  const b = new Uint8Array(24)
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  b.set([0x00, 0x00, 0x00, 0x0d], 8) // IHDR length
  b.set([0x49, 0x48, 0x44, 0x52], 12) // "IHDR"
  new DataView(b.buffer).setUint32(16, width)
  new DataView(b.buffer).setUint32(20, height)
  return b
}

/** A JPEG whose SOF0 sits after `leading` filler segments, to exercise the walk. */
function jpeg(width: number, height: number, leading: Uint8Array[] = []): Uint8Array {
  const sof = new Uint8Array(11)
  sof.set([0xff, 0xc0, 0x00, 0x11, 0x08], 0) // SOF0, length 17, 8-bit precision
  new DataView(sof.buffer).setUint16(5, height)
  new DataView(sof.buffer).setUint16(7, width)
  return concat([new Uint8Array([0xff, 0xd8]), ...leading, sof, new Uint8Array(8)])
}

/** A JPEG APPn-style segment of `length` bytes (length counts its own 2 bytes). */
function jpegSegment(marker: number, length: number): Uint8Array {
  const seg = new Uint8Array(2 + length)
  seg.set([0xff, marker], 0)
  new DataView(seg.buffer).setUint16(2, length)
  return seg
}

function webpEnvelope(fourcc: string, chunk: Uint8Array): Uint8Array {
  const head = new Uint8Array(16)
  head.set(ascii('RIFF'), 0)
  head.set(ascii('WEBP'), 8)
  head.set(ascii(fourcc), 12)
  return concat([head, chunk, new Uint8Array(32)])
}

function webpLossy(width: number, height: number): Uint8Array {
  // Chunk body: 10 bytes before the dimensions, which land at absolute 26/28.
  const body = new Uint8Array(16)
  const view = new DataView(body.buffer)
  view.setUint16(10, width, true)
  view.setUint16(12, height, true)
  return webpEnvelope('VP8 ', body)
}

function webpLossless(width: number, height: number): Uint8Array {
  // Absolute offset 21 is 5 bytes into the chunk body (16 + 4 chunk length + 1).
  const body = new Uint8Array(16)
  new DataView(body.buffer).setUint32(5, (width - 1) | ((height - 1) << 14), true)
  return webpEnvelope('VP8L', body)
}

function webpExtended(width: number, height: number): Uint8Array {
  // Absolute offsets 24 and 27 are 8 and 11 bytes into the chunk body.
  const body = new Uint8Array(16)
  writeUint24LE(body, 8, width - 1)
  writeUint24LE(body, 11, height - 1)
  return webpEnvelope('VP8X', body)
}

function writeUint24LE(b: Uint8Array, o: number, value: number): void {
  b[o] = value & 0xff
  b[o + 1] = (value >> 8) & 0xff
  b[o + 2] = (value >> 16) & 0xff
}

const ascii = (s: string): Uint8Array => Uint8Array.from(s, (c) => c.charCodeAt(0))

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let offset = 0
  for (const p of parts) {
    out.set(p, offset)
    offset += p.length
  }
  return out
}

describe('detectImageMime', () => {
  it('identifies each accepted format from its magic bytes', () => {
    expect(detectImageMime(png(1, 1))).toBe('image/png')
    expect(detectImageMime(jpeg(1, 1))).toBe('image/jpeg')
    expect(detectImageMime(webpLossy(1, 1))).toBe('image/webp')
  })

  it('rejects formats this app does not accept', () => {
    expect(detectImageMime(ascii('%PDF-1.7'))).toBeNull() // PDF
    expect(detectImageMime(ascii('GIF89a....'))).toBeNull() // GIF
    expect(detectImageMime(ascii('OggS'))).toBeNull() // audio
    expect(detectImageMime(ascii('<svg xmlns='))).toBeNull() // SVG — scriptable, never accepted
  })

  it('rejects empty and truncated input rather than reading past the end', () => {
    expect(detectImageMime(new Uint8Array(0))).toBeNull()
    expect(detectImageMime(new Uint8Array([0xff, 0xd8]))).toBeNull() // JPEG needs 3
    expect(detectImageMime(png(1, 1).slice(0, 7))).toBeNull() // PNG needs 8
    expect(detectImageMime(webpLossy(1, 1).slice(0, 11))).toBeNull() // WebP needs 12
  })

  it('reads the bytes, not the claimed format: a JPEG named .png is still a JPEG', () => {
    // This is the whole point of the module. An uploader controls the filename,
    // the extension and the Content-Type header; they do not control the header.
    expect(detectImageMime(jpeg(4, 4))).toBe('image/jpeg')
  })

  it('is not fooled by RIFF containers that are not WebP', () => {
    const wav = concat([ascii('RIFF'), new Uint8Array(4), ascii('WAVE'), new Uint8Array(16)])
    expect(detectImageMime(wav)).toBeNull()
  })
})

describe('extensionForImageMime', () => {
  it('maps every accepted mime to an extension', () => {
    expect(extensionForImageMime('image/jpeg')).toBe('.jpg')
    expect(extensionForImageMime('image/png')).toBe('.png')
    expect(extensionForImageMime('image/webp')).toBe('.webp')
  })

  it('covers the whole accepted set, so a new format cannot be added silently', () => {
    for (const mime of IMAGE_MIME_TYPES) {
      expect(extensionForImageMime(mime)).toMatch(/^\.[a-z]+$/)
    }
  })
})

describe('readImageDimensions', () => {
  it('reads PNG dimensions from IHDR', () => {
    expect(readImageDimensions(png(1920, 1080))).toEqual({ width: 1920, height: 1080 })
  })

  it('reads JPEG dimensions from the start-of-frame header', () => {
    expect(readImageDimensions(jpeg(800, 600))).toEqual({ width: 800, height: 600 })
  })

  it('walks past leading JPEG segments to reach the frame header', () => {
    // A real photo has EXIF and quantisation tables before the frame; the
    // dimensions are not at a fixed offset the way PNG's are.
    const withPreamble = jpeg(640, 480, [jpegSegment(0xe1, 40), jpegSegment(0xdb, 67)])
    expect(readImageDimensions(withPreamble)).toEqual({ width: 640, height: 480 })
  })

  it('steps over fill bytes between JPEG segments instead of giving up', () => {
    // A JPEG may pad between segments with bytes that are not a marker start.
    // Bailing on the first one would report "no dimensions" for a perfectly
    // valid photo, and the upload would then be refused as damaged.
    //
    // The filler goes AFTER a real segment, not straight after the start-of-image
    // marker: the three-byte JPEG signature is `ff d8 ff`, so a file whose third
    // byte is filler is not recognised as a JPEG in the first place.
    const padded = jpeg(120, 90, [jpegSegment(0xe0, 8), new Uint8Array([0x00, 0x00, 0x00])])
    expect(readImageDimensions(padded)).toEqual({ width: 120, height: 90 })
  })

  it('does not mistake DHT/JPG/DAC for a frame header despite their marker range', () => {
    // 0xc4, 0xc8 and 0xcc sit inside SOF0..SOF15 numerically but are not frames.
    // Reading one as a frame yields whatever bytes follow, silently and wrongly.
    const withImpostors = jpeg(300, 200, [
      jpegSegment(0xc4, 20),
      jpegSegment(0xcc, 12),
      jpegSegment(0xc8, 8),
    ])
    expect(readImageDimensions(withImpostors)).toEqual({ width: 300, height: 200 })
  })

  it('gives up on a malformed JPEG segment length instead of looping forever', () => {
    // A declared length below 2 cannot contain its own length bytes. Trusting it
    // steps the cursor backwards, and the walk never terminates.
    const malformed = concat([
      new Uint8Array([0xff, 0xd8]),
      new Uint8Array([0xff, 0xe1, 0x00, 0x01]),
      new Uint8Array(24),
    ])
    expect(readImageDimensions(malformed)).toBeNull()
  })

  it('reads all three WebP chunk layouts', () => {
    expect(readImageDimensions(webpLossy(320, 240))).toEqual({ width: 320, height: 240 })
    expect(readImageDimensions(webpLossless(320, 240))).toEqual({ width: 320, height: 240 })
    expect(readImageDimensions(webpExtended(320, 240))).toEqual({ width: 320, height: 240 })
  })

  it('handles the largest dimensions each format can express', () => {
    // A PNG dimension is a full uint32; reading it with a signed shift would
    // come back negative, and a negative source size makes every pin coordinate
    // meaningless rather than merely wrong.
    expect(readImageDimensions(png(4_294_967_295, 1))).toEqual({
      width: 4_294_967_295,
      height: 1,
    })
    expect(readImageDimensions(jpeg(65_535, 65_535))).toEqual({ width: 65_535, height: 65_535 })
    expect(readImageDimensions(webpLossy(16_383, 16_383))).toEqual({
      width: 16_383,
      height: 16_383,
    })
    expect(readImageDimensions(webpExtended(16_777_216, 1))).toEqual({
      width: 16_777_216,
      height: 1,
    })
  })

  it('returns null for bytes that are not an image at all', () => {
    expect(readImageDimensions(ascii('%PDF-1.7 and then some'))).toBeNull()
    expect(readImageDimensions(new Uint8Array(0))).toBeNull()
  })

  it('returns null for a header that is truncated mid-way', () => {
    // Every reader length-checks before indexing; without that these would read
    // undefined bytes as zero and report a plausible-looking size of 0×0.
    expect(readImageDimensions(png(100, 100).slice(0, 20))).toBeNull()
    expect(readImageDimensions(jpeg(100, 100).slice(0, 6))).toBeNull()
    expect(readImageDimensions(webpLossy(100, 100).slice(0, 29))).toBeNull()
  })

  it('returns null for a WebP whose chunk type it does not know', () => {
    expect(readImageDimensions(webpEnvelope('ANIM', new Uint8Array(16)))).toBeNull()
  })
})

describe('the media-kind vocabulary', () => {
  it('is closed, and every value in it is an image role', () => {
    // Images only, decided 2026-08-08. The set is asserted literally rather
    // than by length: adding a member is a design decision with a byte-level
    // detector, a size policy and a serve-path question behind it, and this
    // failing is where that conversation should start.
    expect([...MEDIA_KINDS]).toEqual(['image', 'map'])
  })

  it('rejects the free-text values dm-manager allowed', () => {
    for (const legacy of ['portrait', 'handout', 'audio', 'pdf', '', 'Image']) {
      expect(isMediaKind(legacy)).toBe(false)
    }
    for (const kind of MEDIA_KINDS) expect(isMediaKind(kind)).toBe(true)
  })
})
