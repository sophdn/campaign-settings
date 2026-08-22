import { deflateSync } from 'node:zlib'

/**
 * Real image bytes for tests.
 *
 * The upload path decides what a file is by reading its header, so a test that
 * fed it a placeholder would be testing nothing. These build genuine files: the
 * PNG is a complete, renderable image (signature, IHDR, deflated IDAT, IEND), so
 * the same bytes work for a server test asserting the stored mime AND for a
 * browser e2e that has to actually paint it and draw it to a canvas.
 *
 * Committing binary fixtures was the alternative. Generating them keeps the
 * dimensions a parameter — several assertions turn on a specific width and
 * height — and keeps a public-mirror repo free of opaque blobs.
 */

/** A complete RGB PNG of the given size, filled with a deterministic gradient. */
export function makePng(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // colour type: truecolour RGB
  // Each scanline is a filter byte followed by three bytes per pixel. The
  // gradient makes a downscaled thumbnail visibly differ from a blank image,
  // which is what lets an e2e tell a real thumbnail from a placeholder.
  const raw = Buffer.alloc(height * (1 + width * 3))
  for (let y = 0; y < height; y++) {
    const rowStart = y * (1 + width * 3)
    raw[rowStart] = 0 // filter: none
    for (let x = 0; x < width; x++) {
      const p = rowStart + 1 + x * 3
      raw[p] = Math.floor((x * 255) / Math.max(width, 1))
      raw[p + 1] = Math.floor((y * 255) / Math.max(height, 1))
      raw[p + 2] = 128
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

/** A minimal JPEG carrying a real start-of-frame header at the given size. */
export function makeJpeg(width: number, height: number): Buffer {
  const sof = Buffer.alloc(11)
  sof.writeUInt8(0xff, 0)
  sof.writeUInt8(0xc0, 1) // SOF0
  sof.writeUInt16BE(0x0011, 2) // segment length
  sof.writeUInt8(8, 4) // sample precision
  sof.writeUInt16BE(height, 5)
  sof.writeUInt16BE(width, 7)
  return Buffer.concat([Buffer.from([0xff, 0xd8]), sof, Buffer.alloc(8), Buffer.from([0xff, 0xd9])])
}

/** Bytes that are recognisably NOT an image — used to prove the refusal path. */
export function makeNotAnImage(): Buffer {
  return Buffer.from('%PDF-1.7\nthis is a PDF wearing a .png extension\n', 'ascii')
}

/**
 * An image whose magic bytes are valid but whose dimension header is truncated:
 * recognisably a PNG, unusable as one. Refused, because a map recorded with no
 * source size makes every pin coordinate on it meaningless.
 */
export function makeHeaderlessPng(): Buffer {
  return Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00])
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([length, body, crc])
}

function crc32(buf: Buffer): number {
  let c = ~0
  for (const byte of buf) {
    c ^= byte
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1))
  }
  return ~c >>> 0
}
