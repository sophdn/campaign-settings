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
 * Columns dropped on the way out because they name an ACCOUNT.
 *
 * An export crosses servers. Account ids do not: the far side has its own
 * accounts, and `import.ts` inserts rows verbatim, so a surviving reference
 * would meet a foreign key that has nothing to satisfy it and fail the whole
 * restore — turning a backup into an error at the moment someone needs it.
 *
 * This is the same rule `tables.ts` already applies one level up by excluding
 * `entity_visibility` and `passage_visibility` wholesale. `pc_details` cannot be
 * excluded that way — it carries a kind's real content — so the one
 * account-coupled COLUMN is dropped instead. A PC page lands on the far side
 * unlinked, exactly as a restricted entity lands with no grants, and the DM
 * re-links it to whoever plays it there.
 */
const ACCOUNT_COUPLED_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  pc_details: ['account_id'],
}

function stripAccountColumns(table: string, row: Record<string, unknown>): Record<string, unknown> {
  const drop = ACCOUNT_COUPLED_COLUMNS[table]
  if (!drop) return row
  return Object.fromEntries(Object.entries(row).filter(([k]) => !drop.includes(k)))
}

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
    const rows = await view
      .selectFrom(table)
      .selectAll()
      .where('world_id', '=', ctx.worldId)
      .execute()
    tables[table] = rows.map((r) => stripAccountColumns(table, r))
  }
  return { version: WORLD_EXPORT_VERSION, tables }
}
