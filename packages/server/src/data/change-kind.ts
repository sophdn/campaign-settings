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
 * Attachment rows keyed by an entity id, tagged with the kind that id must be for
 * the row to be meaningful. When an entity changes kind, the rows where it played
 * its OLD kind's role go stale, so we clear them (Decision 5 of the plan).
 *
 * This list held twenty-two entries until migration 0017 folded nine per-kind
 * junction tables into `entity_relationships`. It did NOT become empty: the four
 * entries below are the two currency-attachment tables, which 0017 deliberately
 * left in place (they carry `visibility` and `deleted_at`, so they are content
 * rows on the seam, not junctions). Their stale-row cleanup is as live as it was.
 *
 * ── AND THE TYPED RELATIONSHIPS ARE DELIBERATELY NOT LISTED ──
 *
 * The nine folded tables were cleared on reclassify; the relationships they became
 * are not, and that is a decision rather than an omission. Nothing in the system
 * ties a relationship type to the kinds at its ends: `RELATIONSHIP_TYPES` carries
 * no kind constraint, the route validates only that the type is in the vocabulary,
 * and `createRelationship` checks only that both endpoints are VISIBLE — never
 * what they are. So `speaks` from an organization to a language is already
 * assertable today, on purpose.
 *
 * Clearing here would therefore delete, at reclassify time, rows that the create
 * path accepts at write time — enforcing an invariant nothing else enforces, and
 * doing it destructively. It would also be the wrong reading of a kind change: a
 * DM who reclassifies an NPC as a PC has not stopped meaning that they speak
 * Latin. The junction tables had to be cleared because a row in `npc_languages`
 * whose `npc_id` is no longer an npc is structurally nonsense; a relationship row
 * is still exactly as true as it was.
 *
 * If a future change ever DOES constrain endpoint kinds, it belongs at the write
 * boundary first, and only then here.
 */
const KIND_ATTACHMENT_REFS: ReadonlyArray<{ kind: string; table: string; col: string }> = [
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
 * kind; and the entity's now-stale kind-specific ATTACHMENT rows are cleared. Its
 * typed relationships are deliberately kept — see `KIND_ATTACHMENT_REFS`.
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

    for (const ref of KIND_ATTACHMENT_REFS) {
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
