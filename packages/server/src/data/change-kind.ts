import type { RegistryKind } from '@campaign-settings/shared'
import { type Kysely, sql } from 'kysely'
import { assertContentWrite } from '../authz/content'
import { CONTENT_REPOS } from './content-repos'
import type { WorldContext } from './context'
import { DETAIL_SPECS } from './entity-details'

const NOW = sql<Date>`now()`

/**
 * INVARIANT FOR ANY FUTURE ENTITY MERGE OR DEDUP (bug 1180).
 *
 * There is no merge feature today, and this file is where one would land — it
 * is already the destructive-transform site. When it is written:
 *
 *   1. **Resolve conflicts by RICHNESS, never by id or age.** Keep the record
 *      with the most populated attributes and links. `min(id)` is the tempting
 *      choice because it is stable and cheap; it is also how the team whose
 *      report produced this rule deleted a fully-statted character in favour of
 *      an older empty row.
 *   2. **Never hard-delete the loser without migrating its unique fields and
 *      links first.** "The winner had a name" is not a reason to drop the
 *      loser's stat block.
 *   3. **An automated merge may not blank a populated field.** Same rule the
 *      suggestion queue now enforces in `sanitizeProposed` — emptiness is not
 *      an edit, and a bulk operation is the worst place to learn otherwise.
 *
 * `changeKind` below is deliberately NOT a counterexample: it clears
 * type-specific fields because they stop being meaningful when the kind
 * changes, and it is an explicit, owner-initiated, single-entity act.
 */

/** Thrown when a kind change targets a non-content kind. Mapped to HTTP 400. */
export class KindChangeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'KindChangeError'
  }
}

/**
 * Junction / attachment rows keyed by an entity id, tagged with the kind that id
 * must be for the row to be meaningful. When an entity changes kind, the rows
 * where it played its OLD kind's role go stale, so we clear them (Decision 5 of
 * the plan). None of these are surfaced in the web app today; the cleanup keeps
 * the relational graph honest.
 */
const KIND_JUNCTION_REFS: ReadonlyArray<{ kind: string; table: string; col: string }> = [
  { kind: 'culture', table: 'culture_languages', col: 'culture_id' },
  { kind: 'language', table: 'culture_languages', col: 'language_id' },
  { kind: 'culture', table: 'culture_magic_systems', col: 'culture_id' },
  { kind: 'magic_system', table: 'culture_magic_systems', col: 'magic_system_id' },
  { kind: 'culture', table: 'culture_pantheons', col: 'culture_id' },
  { kind: 'pantheon', table: 'culture_pantheons', col: 'pantheon_id' },
  { kind: 'npc', table: 'npc_languages', col: 'npc_id' },
  { kind: 'language', table: 'npc_languages', col: 'language_id' },
  { kind: 'npc', table: 'npc_magic_systems', col: 'npc_id' },
  { kind: 'magic_system', table: 'npc_magic_systems', col: 'magic_system_id' },
  { kind: 'pc', table: 'pc_languages', col: 'pc_id' },
  { kind: 'language', table: 'pc_languages', col: 'language_id' },
  { kind: 'pc', table: 'pc_magic_systems', col: 'pc_id' },
  { kind: 'magic_system', table: 'pc_magic_systems', col: 'magic_system_id' },
  { kind: 'settlement', table: 'settlement_languages', col: 'settlement_id' },
  { kind: 'language', table: 'settlement_languages', col: 'language_id' },
  { kind: 'resource', table: 'resource_locations', col: 'resource_id' },
  { kind: 'location', table: 'resource_locations', col: 'location_id' },
  { kind: 'settlement', table: 'settlement_currency_attachments', col: 'settlement_id' },
  { kind: 'currency', table: 'settlement_currency_attachments', col: 'currency_id' },
  { kind: 'organization', table: 'organization_currency_attachments', col: 'organization_id' },
  { kind: 'currency', table: 'organization_currency_attachments', col: 'currency_id' },
]

// Loose view for the dynamic-table detail/junction writes (kysely can't keep a
// runtime table name well-typed; the seam uses the same cast idiom).
type LooseView = Record<string, Record<string, unknown>>

/**
 * Reclassify an entity to a different content kind. Because storage is now
 * class-table inheritance, this is a base-row `kind` update plus a detail-row
 * swap — no cross-table move, no polymorphic-reference repointing (the
 * `entities.id` is stable and every reference keys off it). Owner-only.
 *
 * Semantics: the shared columns (name/description/visibility/imported_metadata)
 * are preserved; the old kind's detail row is dropped (its columns have no home
 * in the new kind) and a fresh, all-defaults detail row is created for the new
 * kind; and the entity's now-stale kind-specific junction rows are cleared.
 *
 * Returns the reclassified entity (flat, with the new kind's detail merged), or
 * undefined when no live entity with that id exists in the world.
 */
export async function changeEntityKind(
  ctx: WorldContext,
  id: string,
  toKind: string,
): Promise<{ id: string } | undefined> {
  assertContentWrite(ctx)
  if (!CONTENT_REPOS[toKind]) throw new KindChangeError(`not a content kind: ${toKind}`)

  const moved = await ctx.db.transaction().execute(async (trx) => {
    const cur = await trx
      .selectFrom('entities')
      .select(['id', 'kind'])
      .where('world_id', '=', ctx.worldId)
      .where('id', '=', id)
      .where('deleted_at', 'is', null)
      .executeTakeFirst()
    if (!cur) return false
    if (cur.kind === toKind) return true // already this kind — no-op

    const loose = trx as unknown as Kysely<LooseView>
    await trx
      .updateTable('entities')
      .set({ kind: toKind, updated_at: NOW })
      .where('world_id', '=', ctx.worldId)
      .where('id', '=', id)
      .execute()

    const oldDetail = DETAIL_SPECS[cur.kind as RegistryKind]
    if (oldDetail) await loose.deleteFrom(oldDetail.table).where('entity_id', '=', id).execute()

    for (const ref of KIND_JUNCTION_REFS) {
      if (ref.kind === cur.kind) await loose.deleteFrom(ref.table).where(ref.col, '=', id).execute()
    }

    const newDetail = DETAIL_SPECS[toKind as RegistryKind]
    if (newDetail) {
      await loose
        .insertInto(newDetail.table)
        .values({ entity_id: id, world_id: ctx.worldId })
        .execute()
    }
    return true
  })

  if (!moved) return undefined
  return CONTENT_REPOS[toKind].get(ctx, id)
}
