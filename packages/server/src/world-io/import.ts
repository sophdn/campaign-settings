import type { Kysely } from 'kysely'
import type { ImportCounts } from '../importer/import-world'
import { importWorldDb } from '../importer/import-world'
import {
  insertFoldedRelationships,
  LEGACY_JUNCTION_FOLDS,
  SKIPPED_SUFFIX,
} from '../importer/mappers'
import type { Database } from '../db/schema'
import { jsonb } from '../db/json'
import { createTenancy } from '../tenancy'
import type { WorldExport } from './export'
import { WORLD_CONTENT_TABLES } from './tables'

type WorldTableRow = { world_id: string } & Record<string, unknown>
type WorldDbView = Record<string, WorldTableRow>

/** Re-key a row to the target world; wrap array-valued jsonb so pg doesn't read it as an array literal. */
function prepareRow(row: Record<string, unknown>, worldId: string): WorldTableRow {
  // Always bind world_id to the target, whether or not the source row carried one.
  const out: Record<string, unknown> = { world_id: worldId }
  for (const [k, v] of Object.entries(row)) {
    if (k === 'world_id') continue
    else if (Array.isArray(v)) out[k] = jsonb(v)
    else out[k] = v
  }
  return out as WorldTableRow
}

/**
 * Import a {@link WorldExport} into `worldId` (typically a freshly created
 * world). Rows are inserted in FK-dependency order with their world_id rebound;
 * entity ids and entity-to-entity FKs are preserved. Intended for a fresh target
 * database (ids are global PKs, so re-importing alongside the source collides).
 */
export async function importWorldExport(
  db: Kysely<Database>,
  worldId: string,
  data: WorldExport,
): Promise<ImportCounts> {
  const view = db as unknown as Kysely<WorldDbView>
  const counts: ImportCounts = {}
  for (const table of WORLD_CONTENT_TABLES) {
    const rows = data.tables[table] ?? []
    counts[table] = rows.length
    if (rows.length === 0) continue
    await view
      .insertInto(table)
      .values(rows.map((r) => prepareRow(r, worldId)))
      .execute()
  }
  await foldLegacyJunctions(db, worldId, data, counts)
  return counts
}

/**
 * Fold an archive's pre-0017 junction tables into `entity_relationships`.
 *
 * WHY THIS EXISTS. The loop above walks `WORLD_CONTENT_TABLES`, and 0017 removed
 * the nine junction tables from that list. An archive taken BEFORE 0017 still
 * carries them as top-level keys, so without this the loop reads straight past
 * them and the import reports success having dropped every relation they held —
 * from a file the user reasonably believes is a complete backup. That is the same
 * silent loss the SQLite importer guards against, so it gets the same treatment
 * through the same mappers rather than a second implementation.
 *
 * A post-0017 archive has none of these keys and this is a no-op: the relations
 * are already in the `entity_relationships` rows the loop above inserted.
 */
async function foldLegacyJunctions(
  db: Kysely<Database>,
  worldId: string,
  data: WorldExport,
  counts: ImportCounts,
): Promise<void> {
  // The archive's own entities are the universe here — it imports into a fresh
  // world — so they are what an endpoint must resolve against.
  const entityIds = new Set((data.tables.entities ?? []).map((r) => String(r.id)))

  for (const [table, map] of Object.entries(LEGACY_JUNCTION_FOLDS)) {
    const rows = data.tables[table] ?? []
    if (rows.length === 0) continue
    counts[table] = rows.length
    const skipped = await insertFoldedRelationships(
      db,
      rows.map((r) => map(r, worldId)),
      entityIds,
    )
    if (skipped > 0) counts[`${table}${SKIPPED_SUFFIX}`] = skipped
  }
}

/**
 * Migrate a dm-manager SQLite world up: create a new world owned by `ownerId`
 * and import the export into it. Owner-gated by construction (the world is the
 * owner's) and world-scoped (the importer writes only under the new world id).
 */
export async function importDmManagerWorld(
  db: Kysely<Database>,
  ownerId: string,
  name: string,
  sqlitePath: string,
): Promise<{ worldId: string; slug: string; counts: ImportCounts }> {
  const world = await createTenancy(db).createWorld(ownerId, name)
  const counts = await importWorldDb(db, world.id, sqlitePath)
  return { worldId: world.id, slug: world.slug, counts }
}
