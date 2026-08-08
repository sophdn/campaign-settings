import type { Kysely } from 'kysely'
import type { ImportCounts } from '../importer/import-world'
import { importWorldDb } from '../importer/import-world'
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
  return counts
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
