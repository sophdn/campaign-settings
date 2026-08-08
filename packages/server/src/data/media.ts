import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  detectImageMime,
  extensionForImageMime,
  type ImageMimeType,
  type MediaKind,
  readImageDimensions,
} from '@campaign-settings/shared'
import type { Selectable } from 'kysely'
import { assertContentWrite } from '../authz/content'
import { newId } from '../db/ids'
import type { MediaAttachmentsTable } from '../db/schema'
import type { WorldContext } from './context'

/**
 * Media attachments — images (and later other files) hung off a content entity
 * (`owner_kind`/`owner_id`). The row records where the bytes live (`file_path`,
 * relative to the uploads root) plus the metadata a viewer needs. Like touches,
 * a media row has no `dm_only` of its own: its visibility IS its owner entity's,
 * enforced at the route by refusing to list/serve media whose owner the actor
 * cannot see.
 */

/** Uploads root: `packages/server/.uploads` unless UPLOADS_DIR overrides it. */
export const DEFAULT_UPLOADS_DIR = fileURLToPath(new URL('../../.uploads', import.meta.url))
export const resolveUploadsDir = (configured?: string): string =>
  configured ?? process.env.UPLOADS_DIR ?? DEFAULT_UPLOADS_DIR

export type MediaAttachment = Selectable<MediaAttachmentsTable>

export interface NewMedia {
  owner_kind: string
  owner_id: string
  /**
   * The role this attachment plays — a CLOSED set (`image` | `map`), not free
   * text. Typed rather than validated at runtime because every caller is
   * server-side and constructs it from a literal; nothing a request carries
   * reaches this field. The importer, whose rows come from outside, is the one
   * place that has to narrow, and it does.
   */
  media_kind: MediaKind
  file_path: string
  thumbnail_path?: string | null
  original_filename: string
  mime_type: string
  byte_size: number
}

/** Live media for one owner entity (world-scoped), oldest first. Member-read. */
export function listMediaForOwner(
  ctx: WorldContext,
  ownerKind: string,
  ownerId: string,
): Promise<MediaAttachment[]> {
  return ctx.db
    .selectFrom('media_attachments')
    .selectAll()
    .where('world_id', '=', ctx.worldId)
    .where('owner_kind', '=', ownerKind)
    .where('owner_id', '=', ownerId)
    .where('deleted_at', 'is', null)
    .orderBy('created_at')
    .execute()
}

/** A single live media row by id (world-scoped). */
export function getMediaById(ctx: WorldContext, id: string): Promise<MediaAttachment | undefined> {
  return ctx.db
    .selectFrom('media_attachments')
    .selectAll()
    .where('world_id', '=', ctx.worldId)
    .where('id', '=', id)
    .where('deleted_at', 'is', null)
    .executeTakeFirst()
}

/** Attach media to an entity (owner-only). */
export async function createMediaAttachment(
  ctx: WorldContext,
  input: NewMedia,
  id: string = newId(),
): Promise<MediaAttachment> {
  assertContentWrite(ctx)
  return ctx.db
    .insertInto('media_attachments')
    .values({
      id,
      world_id: ctx.worldId,
      owner_kind: input.owner_kind,
      owner_id: input.owner_id,
      media_kind: input.media_kind,
      file_path: input.file_path,
      thumbnail_path: input.thumbnail_path ?? null,
      original_filename: input.original_filename,
      mime_type: input.mime_type,
      byte_size: input.byte_size,
    })
    .returningAll()
    .executeTakeFirstOrThrow()
}

// ── writing bytes ───────────────────────────────────────────────────────────

/**
 * Raised when uploaded bytes are not a raster image this app accepts. Mapped to
 * a 400 by name, so a `.png` full of PDF gets a refusal that says what happened
 * rather than a 500 that says nothing.
 */
export class UnsupportedImageError extends Error {
  constructor(message = 'that file is not a JPEG, PNG, or WebP image') {
    super(message)
    this.name = 'UnsupportedImageError'
  }
}

/** Bytes identified as an image, with the size their header reports. */
export interface IdentifiedImage {
  mime: ImageMimeType
  width: number
  height: number
}

/**
 * What these bytes actually are, or a refusal.
 *
 * The header is the only evidence considered. The uploaded filename, its
 * extension, and the declared Content-Type are all written by whoever is
 * uploading; treating any of them as the answer is how a server ends up storing
 * something it never agreed to accept.
 *
 * A file whose magic bytes say "image" but whose dimension header is truncated
 * is also refused: it is not usable, and a map recorded with no source size
 * makes every pin coordinate on it meaningless.
 */
export function identifyImage(bytes: Uint8Array): IdentifiedImage {
  const mime = detectImageMime(bytes)
  if (!mime) throw new UnsupportedImageError()
  const dims = readImageDimensions(bytes)
  if (!dims || dims.width <= 0 || dims.height <= 0) {
    throw new UnsupportedImageError('that image is damaged — its dimensions could not be read')
  }
  return { mime, width: dims.width, height: dims.height }
}

/**
 * Where a stored file lives, relative to the uploads root. EVERY segment is
 * composed by the server: the world and owner come from the verified request
 * context, the id is minted here, and the extension comes from the DETECTED
 * mime — never from the uploaded name, which may contain anything at all.
 *
 * World-scoping the first segment means deleting a world is one subtree removal,
 * and one tenant's bytes never share a directory with another's.
 */
export function mediaFilePath(
  worldId: string,
  ownerKind: string,
  ownerId: string,
  id: string,
  mime: ImageMimeType,
): string {
  return join(worldId, ownerKind, ownerId, `${id}${extensionForImageMime(mime)}`)
}

/**
 * Write bytes into the uploads root at a server-composed relative path.
 *
 * Bytes land BEFORE the row that will point at them, so a failure leaves a file
 * with no row rather than a row with no file. That is the tolerable direction: a
 * row pointing at nothing is a broken image on the page, while an unreferenced
 * file is inert.
 */
export async function writeMediaFile(
  uploadsDir: string,
  relativePath: string,
  bytes: Uint8Array,
): Promise<void> {
  const abs = join(uploadsDir, relativePath)
  await mkdir(dirname(abs), { recursive: true })
  await writeFile(abs, bytes)
}

/**
 * Remove a stored file. Missing is success — the caller's goal is that the file
 * is gone, and a delete that fails because it already went would strand the row.
 */
export async function removeMediaFile(uploadsDir: string, relativePath: string): Promise<void> {
  await rm(join(uploadsDir, relativePath), { force: true })
}

/**
 * Delete an attachment: its bytes, its thumbnail, and its row.
 *
 * The row is HARD-deleted rather than tombstoned. Media rows are not campaign
 * prose, and the world's byte ceiling counts live rows — so a tombstoned row
 * whose bytes are still on disk is exactly how the ceiling and the disk drift
 * apart. Keeping them in agreement is worth more than an undo for a file the
 * owner can simply upload again.
 *
 * Returns false when there was nothing to delete, so the route can 404 rather
 * than report success for an id that never existed.
 */
export async function deleteMediaAttachment(
  ctx: WorldContext,
  uploadsDir: string,
  id: string,
): Promise<boolean> {
  assertContentWrite(ctx)
  const media = await getMediaById(ctx, id)
  if (!media) return false
  await ctx.db
    .deleteFrom('media_attachments')
    .where('world_id', '=', ctx.worldId)
    .where('id', '=', id)
    .executeTakeFirstOrThrow()
  // No second check on the delete count: `getMediaById` above already proved the
  // row was there, and if a concurrent caller removed it first the outcome the
  // caller asked for — that it is gone — holds either way.
  //
  // Files go after the row, the mirror of upload: an unreferenced file is inert,
  // a row pointing at bytes that are gone renders as a broken image.
  await removeMediaFile(uploadsDir, media.file_path)
  if (media.thumbnail_path) await removeMediaFile(uploadsDir, media.thumbnail_path)
  return true
}

/**
 * Attach a browser-generated thumbnail to an existing attachment (owner-only).
 *
 * Separate from the source upload on purpose. Packing two files into one request
 * body means hand-rolling length-prefix framing, which is what a multipart
 * library exists to do and where framing bugs live. The cost of splitting is
 * that a failure between the two leaves `thumbnail_path` null — which is ALREADY
 * a legal state, produced by the legacy importer, and which the UI handles by
 * falling back to the source.
 *
 * The thumbnail comes from the client and is therefore untrusted bytes: it gets
 * the same identification and the same server-composed path as any upload.
 */
export async function attachThumbnail(
  ctx: WorldContext,
  uploadsDir: string,
  id: string,
  bytes: Uint8Array,
): Promise<MediaAttachment | undefined> {
  assertContentWrite(ctx)
  const media = await getMediaById(ctx, id)
  if (!media) return undefined
  const { mime } = identifyImage(bytes)
  const path = mediaFilePath(
    ctx.worldId,
    media.owner_kind,
    media.owner_id,
    `${media.id}-thumb`,
    mime,
  )
  await writeMediaFile(uploadsDir, path, bytes)
  // A replaced thumbnail leaves its predecessor behind unless we say otherwise.
  if (media.thumbnail_path && media.thumbnail_path !== path) {
    await removeMediaFile(uploadsDir, media.thumbnail_path)
  }
  return ctx.db
    .updateTable('media_attachments')
    .set({ thumbnail_path: path })
    .where('world_id', '=', ctx.worldId)
    .where('id', '=', id)
    .returningAll()
    .executeTakeFirst()
}

/** Remove a whole world's uploaded bytes. Called when the world itself is deleted. */
export async function removeWorldMedia(uploadsDir: string, worldId: string): Promise<void> {
  await rm(join(uploadsDir, worldId), { recursive: true, force: true })
}
