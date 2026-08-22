import type { MediaKind } from '@campaign-settings/shared'
import type { Selectable } from 'kysely'
import { assertContentWrite, assertWorldOwner } from '../authz/content'
import type { MapsTable } from '../db/schema'
import type { WorldContext } from './context'
import { listMediaForOwner, type MediaAttachment } from './media'

/**
 * Maps — a world-level image with pins on it, not a column hanging off one
 * entity.
 *
 * The `maps` table has existed since 0001 and arrived with the legacy import
 * without ever being wired to a route. This module wires it, and settles the
 * association the schema left open: a map belongs to the WORLD, and any entity
 * can be pinned on any map. A region map shared by two settlements, or a world
 * map belonging to no single place, both have somewhere to live — neither does
 * if a map is a property of one entity.
 *
 * Reads and writes go through the same `createContentRepository` seam every
 * other content table uses (registered as `ENTITY_REPOS.map`), so `maps.
 * visibility` behaves exactly like an entity's: `public` to members, `dm_only`
 * to the owner alone, `restricted` to granted players.
 *
 * ## Where a map's image lives
 *
 * In `media_attachments`, with `owner_kind = 'map'` — NOT in the `image_path`
 * column beside it. That column is the legacy importer's contract and is left
 * as it was found; going through media instead means the world byte ceiling,
 * the containment-checked raw route, thumbnails and deletion all apply to a map
 * image for free, rather than being reimplemented for one more owner type.
 *
 * `source_width` / `source_height` ARE written on the map row, because
 * `media_attachments` has nowhere to put them and pins are stored as fractions
 * of the source: without them a normalized coordinate has nothing to be
 * normalized against.
 */

export type WorldMap = Selectable<MapsTable>

/** A map plus the image it currently displays, if it has one. */
export interface MapWithImage {
  map: WorldMap
  /** The uploaded image, or null for a map with none yet. */
  image: MediaAttachment | null
}

/** `media_kind` for the image a map displays; distinct from an entity's images. */
export const MAP_MEDIA_KIND: MediaKind = 'map'

/**
 * The image a map displays, or null.
 *
 * The most recent upload wins, so replacing a map's image is an upload rather
 * than a delete-then-upload dance. Earlier ones stay addressable until removed,
 * which is what makes a mis-click recoverable.
 */
export async function getMapImage(
  ctx: WorldContext,
  mapId: string,
): Promise<MediaAttachment | null> {
  const attachments = await listMediaForOwner(ctx, 'map', mapId)
  const images = attachments.filter((m) => m.media_kind === MAP_MEDIA_KIND)
  return images[images.length - 1] ?? null
}

/**
 * Record the pixel size of the image a map now displays.
 *
 * Owner-gated like any content write. Called by the upload route rather than
 * exposed as a patchable field: these two numbers describe the bytes on disk,
 * so letting a client set them would let a client make every pin on that map
 * land in the wrong place.
 */
export async function setMapSourceDimensions(
  ctx: WorldContext,
  mapId: string,
  width: number,
  height: number,
): Promise<void> {
  assertContentWrite(ctx)
  await ctx.db
    .updateTable('maps')
    .set({ source_width: width, source_height: height })
    .where('world_id', '=', ctx.worldId)
    .where('id', '=', mapId)
    .where('deleted_at', 'is', null)
    .execute()
}

/**
 * Per-player grants on a `restricted` map (0016).
 *
 * The map-side twin of `data/entity-visibility.ts`. A grant naming a map cannot
 * live in `entity_visibility` — that table's `entity_id` is foreign-keyed to
 * `entities` and a map is its own table — so maps carry `map_visibility`, which
 * the seam reads through the `grantTable` option on the map repo.
 *
 * Owner-only, like every other grant surface. The read filter these rows feed is
 * still the ONE in `authz/content.ts`; nothing here decides visibility.
 */
export async function grantMapVisibility(
  ctx: WorldContext,
  mapId: string,
  accountId: string,
): Promise<void> {
  assertWorldOwner(ctx, 'map grant')
  await ctx.db
    .insertInto('map_visibility')
    .values({ world_id: ctx.worldId, map_id: mapId, account_id: accountId })
    .onConflict((oc) => oc.columns(['world_id', 'map_id', 'account_id']).doNothing())
    .execute()
}

/** Withdraw a map grant (owner-only). */
export async function revokeMapVisibility(
  ctx: WorldContext,
  mapId: string,
  accountId: string,
): Promise<void> {
  assertWorldOwner(ctx, 'map revoke')
  await ctx.db
    .deleteFrom('map_visibility')
    .where('world_id', '=', ctx.worldId)
    .where('map_id', '=', mapId)
    .where('account_id', '=', accountId)
    .execute()
}

/** The accounts holding a grant on this map (owner-only). */
export async function listMapGrants(ctx: WorldContext, mapId: string): Promise<string[]> {
  assertWorldOwner(ctx, 'map grant list')
  const rows = await ctx.db
    .selectFrom('map_visibility')
    .select('account_id')
    .where('world_id', '=', ctx.worldId)
    .where('map_id', '=', mapId)
    .orderBy('created_at')
    .execute()
  return rows.map((r) => r.account_id)
}
