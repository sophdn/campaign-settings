import { createContentRepository } from '../authz/content'
import { assertContentWrite } from '../authz/content'
import { newId } from '../db/ids'
import type { WorldContext } from './context'

/**
 * Map pins — a marker at a point on a map that names, and links to, an entity.
 *
 * ## The leak this module exists to prevent
 *
 * A pin names an entity, and a map a player may see can carry a pin pointing at
 * an entity they may NOT see. The content seam filters content ROWS; it has no
 * opinion about a pin, because a pin's owner is the map rather than the entity
 * it names. So a pin on a visible map would carry a hidden entity's id, its
 * name, and its location in the world — without that entity ever being opened.
 *
 * Worse, `map_pins.label` is free text the DM writes, independent of the target
 * entity's name. "The Hollow Man's safehouse" spells out the secret whether or
 * not the entity's own name is ever resolved.
 *
 * So every read here resolves each pin's TARGET through the seam and drops the
 * pin whole — coordinates, label and all — when the target is not visible.
 * Filtering the name but keeping the label, or keeping a nameless marker at a
 * revealing position, would both still be the leak.
 *
 * ## Coordinates
 *
 * `x` and `y` are fractions of the SOURCE image, not pixels and not screen
 * positions, with `map_pins_x_check` / `map_pins_y_check` enforcing 0..1 in the
 * database since migration 0001. That is what lets a pin render correctly at any
 * zoom or scroll offset: the viewer's transform is applied at render time rather
 * than baked into the stored value (see `map-viewport.ts` on the web side).
 */

/** The seam instance every pin target is resolved through — no kind filter. */
const entities = createContentRepository('entities')

/** A pin, with enough of its target resolved to render and navigate. */
export interface MapPinView {
  id: string
  map_id: string
  entity_id: string
  x: number
  y: number
  label: string | null
  /** The entity this pin marks, already proven visible to the actor. */
  target: { kind: string; id: string; name: string }
}

export interface NewMapPin {
  map_id: string
  entity_id: string
  x: number
  y: number
  label?: string | null
}

/** Raised when a coordinate is outside the unit square the schema enforces. */
export class PinOutOfBoundsError extends Error {
  constructor(x: number, y: number) {
    super(`a pin must sit on the map: (${x}, ${y}) is outside 0..1`)
    this.name = 'PinOutOfBoundsError'
  }
}

const inUnitRange = (n: number): boolean => Number.isFinite(n) && n >= 0 && n <= 1

/**
 * Pins on one map, filtered to those whose target the actor may see.
 *
 * The caller must have already resolved the MAP through the seam; this filters
 * on the second axis — the targets — which the map's own visibility says
 * nothing about.
 */
export async function listPinsForMap(ctx: WorldContext, mapId: string): Promise<MapPinView[]> {
  const rows = await ctx.db
    .selectFrom('map_pins')
    .selectAll()
    .where('world_id', '=', ctx.worldId)
    .where('map_id', '=', mapId)
    .where('deleted_at', 'is', null)
    .orderBy('created_at')
    .execute()
  return withVisibleTargets(ctx, rows)
}

/**
 * Resolve each pin's target through the seam and drop the ones that do not come
 * back. One batched read, so a map with thirty pins is not thirty queries.
 *
 * A pin whose target was hard-deleted resolves to nothing and is dropped by the
 * same rule that drops a hidden one — so a dangling pin degrades into absence
 * rather than into a marker that navigates nowhere.
 */
async function withVisibleTargets(
  ctx: WorldContext,
  rows: ReadonlyArray<{
    id: string
    map_id: string
    entity_id: string
    x: number
    y: number
    label: string | null
  }>,
): Promise<MapPinView[]> {
  if (rows.length === 0) return []
  const targets = await entities.listByIds(ctx, [...new Set(rows.map((r) => r.entity_id))])
  const byId = new Map(
    targets.map((t) => {
      const row = t as unknown as { id: string; kind: string; name: string }
      return [row.id, { kind: row.kind, id: row.id, name: row.name }]
    }),
  )
  const out: MapPinView[] = []
  for (const row of rows) {
    const target = byId.get(row.entity_id)
    // No target → the pin does not exist for this actor. Not a nameless marker,
    // not a label without a link: nothing. A marker at a telling position is
    // still the leak, and the label is written independently of the name.
    if (!target) continue
    out.push({
      id: row.id,
      map_id: row.map_id,
      entity_id: row.entity_id,
      x: row.x,
      y: row.y,
      label: row.label,
      target,
    })
  }
  return out
}

/** Raised when a pin names an entity that is absent or not visible to the actor. */
export class PinTargetNotFoundError extends Error {
  constructor() {
    super('that entry does not exist in this world')
    this.name = 'PinTargetNotFoundError'
  }
}

/**
 * Place a pin (owner-only).
 *
 * The target is resolved through the seam BEFORE the insert, not after: a pin
 * can then only ever be created against an entity the actor may see, and the
 * view can be built from what that resolution already returned rather than by
 * reading the row back and hoping it resolves a second time.
 *
 * Coordinates are checked in TypeScript first so an out-of-range value reads as
 * a refusal rather than as a raw constraint violation.
 */
export async function createPin(ctx: WorldContext, input: NewMapPin): Promise<MapPinView> {
  assertContentWrite(ctx)
  if (!inUnitRange(input.x) || !inUnitRange(input.y)) {
    throw new PinOutOfBoundsError(input.x, input.y)
  }
  const [target] = await entities.listByIds(ctx, [input.entity_id])
  if (!target) throw new PinTargetNotFoundError()

  const row = await ctx.db
    .insertInto('map_pins')
    .values({
      id: newId(),
      world_id: ctx.worldId,
      map_id: input.map_id,
      entity_id: input.entity_id,
      x: input.x,
      y: input.y,
      label: input.label ?? null,
    })
    .returningAll()
    .executeTakeFirstOrThrow()

  const resolved = target as unknown as { id: string; kind: string; name: string }
  return {
    id: row.id,
    map_id: row.map_id,
    entity_id: row.entity_id,
    x: row.x,
    y: row.y,
    label: row.label,
    target: { kind: resolved.kind, id: resolved.id, name: resolved.name },
  }
}

/** Move or relabel a pin (owner-only). Returns undefined when there is no such pin. */
export async function updatePin(
  ctx: WorldContext,
  id: string,
  patch: { x?: number | undefined; y?: number | undefined; label?: string | null | undefined },
): Promise<MapPinView | undefined> {
  assertContentWrite(ctx)
  if (
    (patch.x !== undefined && !inUnitRange(patch.x)) ||
    (patch.y !== undefined && !inUnitRange(patch.y))
  ) {
    throw new PinOutOfBoundsError(patch.x ?? Number.NaN, patch.y ?? Number.NaN)
  }
  const row = await ctx.db
    .updateTable('map_pins')
    .set({
      ...(patch.x === undefined ? {} : { x: patch.x }),
      ...(patch.y === undefined ? {} : { y: patch.y }),
      ...(patch.label === undefined ? {} : { label: patch.label }),
    })
    .where('world_id', '=', ctx.worldId)
    .where('id', '=', id)
    .where('deleted_at', 'is', null)
    .returningAll()
    .executeTakeFirst()
  if (!row) return undefined
  return (await withVisibleTargets(ctx, [row]))[0]
}

/** Remove a pin (owner-only). Returns whether a live pin was actually removed. */
export async function deletePin(ctx: WorldContext, id: string): Promise<boolean> {
  assertContentWrite(ctx)
  const res = await ctx.db
    .deleteFrom('map_pins')
    .where('world_id', '=', ctx.worldId)
    .where('id', '=', id)
    .executeTakeFirstOrThrow()
  return res.numDeletedRows > 0n
}

/** A map that pins a given entity — one row of the entity page's reverse list. */
export interface MapReference {
  mapId: string
  mapName: string
  pinId: string
  label: string | null
}

/**
 * The maps an entity is pinned on — the reverse of {@link listPinsForMap}, and
 * the "Pinned on maps" section of an entity page.
 *
 * Filtered by MAP visibility here, which is the mirror-image of the leak above:
 * a player looking at an entity they may see must not learn that it appears on
 * a `dm_only` map. The entity's own visibility is already settled by the fact
 * that they are reading its page.
 */
export async function listMapsForEntity(
  ctx: WorldContext,
  entityId: string,
): Promise<MapReference[]> {
  const rows = await ctx.db
    .selectFrom('map_pins')
    .select(['id', 'map_id', 'label'])
    .where('world_id', '=', ctx.worldId)
    .where('entity_id', '=', entityId)
    .where('deleted_at', 'is', null)
    .execute()
  if (rows.length === 0) return []

  const maps = createContentRepository('maps')
  const visible = await maps.listByIds(ctx, [...new Set(rows.map((r) => r.map_id))])
  const nameById = new Map(
    visible.map((m) => {
      const row = m as unknown as { id: string; name: string }
      return [row.id, row.name]
    }),
  )
  return rows
    .flatMap((r) => {
      const mapName = nameById.get(r.map_id)
      return mapName === undefined
        ? []
        : [{ mapId: r.map_id, mapName, pinId: r.id, label: r.label }]
    })
    .sort((a, b) => a.mapName.localeCompare(b.mapName))
}
