import { sql } from 'kysely'
import { assertWorldOwner, createContentRepository } from '../authz/content'
import { ENTITY_REPOS } from './content-repos'
import type { WorldContext } from './context'
import { removeMediaFile } from './media'

/**
 * The trash: soft-deleted content, and the two things an owner can do with it.
 *
 * `DELETE` on any content row has always set `deleted_at` rather than removing
 * it, which made every deletion recoverable in principle and unrecoverable in
 * practice — there was no door back. This module is that door, plus the one
 * that finishes the job.
 *
 * Two properties are load-bearing:
 *
 * - **Owner-only, with no player case at all.** Not "a player sees the deleted
 *   rows they could have seen" — a player has no route here. The trash is a
 *   list of things that are supposed to be gone, and the least surprising
 *   visibility model for it is none.
 * - **Purge requires a row already in the trash.** Destroying content takes two
 *   deliberate acts, delete then purge, so no single request can be permanent
 *   data loss. That guard lives on the seam (`repo.purge`), not here.
 *
 * There is deliberately NO time-to-live and no sweep. Sophi's call, 2026-08-08:
 * deleted content sits in the trash until someone purges it by hand. dm-manager
 * auto-purged after 30 days; carrying that over would mean introducing
 * scheduled-job machinery this server does not have, in exchange for letting a
 * forgotten entity disappear for good while nobody was at the table. Unbounded
 * trash is the cheaper problem, and the world's own entity ceiling
 * (`tenancy/limits.ts`) already bounds how big it can get.
 */

/** One row in the trash, reduced to what a trash list renders and acts on. */
export interface TrashEntry {
  /** The registry kind — `npc`, `settlement`, … plus the bespoke `session`/`map`. */
  kind: string
  id: string
  name: string
  deleted_at: Date | string
}

/**
 * One authorized lister over the whole `entities` base table — no `kind`
 * option, so every content kind arrives in a single query and each row names
 * its own kind. The same shape `wiki/graph.ts` uses, and for the same reason:
 * going per-kind here would be sixteen queries against one table to rebuild
 * information the table already carries.
 *
 * No `detail` spec either. A trash list shows a name and a date; merging every
 * kind's detail columns would be a second query per kind to render nothing.
 */
const allEntities = createContentRepository('entities')

/** The bespoke content tables, which are not rows in `entities`. */
const BESPOKE_TRASH_KINDS = ['session', 'map'] as const

/**
 * Detail columns that point at `entities.id` with NO cascade and NO set-null
 * (migration 0005). Postgres refuses to delete a row anything in this list
 * still names, so a purge that ignored them would fail with a foreign-key error
 * naming a constraint the owner has never heard of.
 *
 * Every one is nullable, so the cleanup is to clear the reference rather than
 * to delete the referencing entity — purging a species must not take the NPCs
 * of that species with it. The NPC keeps its name, its prose, and everything
 * else; it simply no longer names a species that no longer exists.
 *
 * This list is checked against the live schema by `trash.test.ts`, which reads
 * `information_schema` and fails if the database has a blocking reference this
 * array does not — so a future migration that adds one cannot quietly turn
 * purge into a 500.
 */
const BLOCKING_ENTITY_REFS: ReadonlyArray<{ table: string; column: string }> = [
  { table: 'currency_details', column: 'base_rate_to' },
  { table: 'npc_details', column: 'species_id' },
  { table: 'npc_details', column: 'culture_id' },
  { table: 'pc_details', column: 'species_id' },
  { table: 'settlement_details', column: 'culture_id' },
]

/** Thrown inside the purge transaction to roll back when the id was not in the trash. */
class NotInTrashError extends Error {}

/**
 * Everything in this world's trash, newest deletion first.
 *
 * Three queries, one per content table — `entities` covers all sixteen content
 * kinds at once, and `sessions`/`maps` are their own tables. The sort is
 * re-applied across the merged result because each query only orders its own.
 */
export async function listTrash(ctx: WorldContext): Promise<TrashEntry[]> {
  assertWorldOwner(ctx, 'trash read')
  /** What every content table has in common, which is all a trash list reads. */
  type TrashableRow = { id: string; name: string; deleted_at: Date | string; kind?: string }
  const collect = async (
    repo: { listDeleted(ctx: WorldContext): Promise<ReadonlyArray<{ id: string }>> },
    fallbackKind: string,
  ): Promise<TrashEntry[]> =>
    (await repo.listDeleted(ctx)).map((row) => {
      // Rows from `entities` carry their own `kind` column; a session or a map
      // IS its kind, so the table's own name stands in.
      const r = row as TrashableRow
      return { kind: r.kind ?? fallbackKind, id: r.id, name: r.name, deleted_at: r.deleted_at }
    })

  const perTable = await Promise.all([
    collect(allEntities, 'entity'),
    ...BESPOKE_TRASH_KINDS.map((k) =>
      collect(ENTITY_REPOS[k] as NonNullable<(typeof ENTITY_REPOS)[string]>, k),
    ),
  ])
  return perTable
    .flat()
    .sort((a, b) => new Date(b.deleted_at).getTime() - new Date(a.deleted_at).getTime())
}

/**
 * Put a trashed row back. Returns false when nothing in the trash matched the
 * kind and id, so the route 404s instead of reporting a restore that never
 * happened.
 *
 * Dispatched through `ENTITY_REPOS[kind]` rather than the kind-less lister, so
 * restoring an NPC id under `kind=species` is a miss rather than a success —
 * the same by-kind check every other entity route makes.
 */
export async function restoreTrashed(
  ctx: WorldContext,
  kind: string,
  id: string,
): Promise<boolean> {
  const repo = ENTITY_REPOS[kind]
  if (!repo) return false
  return repo.restore(ctx, id)
}

/**
 * Destroy a trashed row for good: its dependents, its uploaded bytes, and the
 * row itself.
 *
 * Everything in the database happens in ONE transaction, so a purge that fails
 * part way leaves the row exactly as it was rather than half-detached from the
 * things that pointed at it. The three shapes of dependent:
 *
 * - **Blocking references** (`BLOCKING_ENTITY_REFS`) are CLEARED. They are other
 *   entities' opinions about this one, and those entities survive.
 * - **Rows that cannot exist without it** — a map's pins, a session's touches —
 *   are DELETED. Both columns are `not null`, so there is no clearing them, and
 *   a pin on no map is not a thing.
 * - **Media attachments** are deleted row-and-bytes, the same pairing
 *   `deleteMediaAttachment` keeps, because `media_attachments` has no foreign
 *   key to hang a cascade on (its owner is polymorphic) and the world's byte
 *   ceiling counts live rows.
 *
 * Files are removed AFTER the transaction commits. If it rolls back, the rows
 * still point at bytes that are still there; the other order would leave a
 * surviving entity with a gallery full of broken images.
 *
 * Returns false when the kind/id names nothing in the trash — including a row
 * that is merely live, which is the guard that makes this two acts, not one.
 */
export async function purgeTrashed(
  ctx: WorldContext,
  uploadsDir: string,
  kind: string,
  id: string,
): Promise<boolean> {
  // Asserted HERE, not just on `repo.purge` at the end: the cleanup below runs
  // first, and a caller who is going to be refused must be refused before any
  // of it touches a row.
  assertWorldOwner(ctx, 'purge')
  const repo = ENTITY_REPOS[kind]
  if (!repo) return false

  // Read the paths before the rows go, and WITHOUT the live-only filter
  // `listMediaForOwner` applies: a tombstoned attachment (the importer can make
  // one) still has bytes on disk, and the point of this pass is that no file
  // outlives the entity it belonged to.
  const media = await ctx.db
    .selectFrom('media_attachments')
    .select(['file_path', 'thumbnail_path'])
    .where('world_id', '=', ctx.worldId)
    .where('owner_kind', '=', kind)
    .where('owner_id', '=', id)
    .execute()
  try {
    await ctx.db.transaction().execute(async (trx) => {
      const txCtx: WorldContext = { ...ctx, db: trx }

      if (kind === 'map') {
        await trx
          .deleteFrom('map_pins')
          .where('world_id', '=', ctx.worldId)
          .where('map_id', '=', id)
          .execute()
      } else if (kind === 'session') {
        await trx
          .deleteFrom('entity_touches')
          .where('world_id', '=', ctx.worldId)
          .where('session_id', '=', id)
          .execute()
      } else {
        for (const ref of BLOCKING_ENTITY_REFS) {
          await sql`
            update ${sql.ref(ref.table)}
               set ${sql.ref(ref.column)} = null
             where world_id = ${ctx.worldId}
               and ${sql.ref(ref.column)} = ${id}
          `.execute(trx)
        }
      }

      await trx
        .deleteFrom('media_attachments')
        .where('world_id', '=', ctx.worldId)
        .where('owner_kind', '=', kind)
        .where('owner_id', '=', id)
        .execute()

      if (!(await repo.purge(txCtx, id))) throw new NotInTrashError()
    })
  } catch (err) {
    if (err instanceof NotInTrashError) return false
    throw err
  }

  for (const m of media) {
    await removeMediaFile(uploadsDir, m.file_path)
    if (m.thumbnail_path) await removeMediaFile(uploadsDir, m.thumbnail_path)
  }
  return true
}
