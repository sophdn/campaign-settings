import type { Kysely } from 'kysely'
import { ForbiddenError } from '../authz/errors'
import type { WorldContext } from '../data/context'
import { WORLD_CONTENT_TABLES } from './tables'

export const WORLD_EXPORT_VERSION = 1

export interface WorldExport {
  version: number
  /** Rows per content table, keyed by table name. */
  tables: Record<string, Record<string, unknown>[]>
}

type WorldTableRow = { world_id: string } & Record<string, unknown>
type WorldDbView = Record<string, WorldTableRow>

/**
 * Dump a world's canonical content to a JSON-serializable document. Owner only
 * — the export contains every row including dm_only, so it must never be reached
 * by a player-initiated path.
 */
export async function exportWorld(ctx: WorldContext): Promise<WorldExport> {
  if (ctx.actor.role !== 'owner') {
    throw new ForbiddenError('world export requires owner role')
  }
  const view = ctx.db as unknown as Kysely<WorldDbView>
  const tables: Record<string, Record<string, unknown>[]> = {}
  for (const table of WORLD_CONTENT_TABLES) {
    tables[table] = await view
      .selectFrom(table)
      .selectAll()
      .where('world_id', '=', ctx.worldId)
      .execute()
  }
  return { version: WORLD_EXPORT_VERSION, tables }
}
