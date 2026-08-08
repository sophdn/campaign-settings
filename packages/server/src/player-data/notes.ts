import { type Selectable, sql } from 'kysely'
import { assertPlayerDataWrite, playerDataReadScope } from '../authz/player-data'
import type { WorldContext } from '../data/context'
import { newId } from '../db/ids'
import type { PlayerNotesTable } from '../db/schema'

/**
 * Player notes — owned by the authoring account. A player reads/writes only
 * their own; the DM (owner role) may read all of a world's notes but not write
 * another account's. Ownership is enforced here in the data layer via the
 * player-data authz helpers, never in handlers.
 */

export type PlayerNote = Selectable<PlayerNotesTable>

const NOW = sql<Date>`now()`

export async function createNote(ctx: WorldContext, input: { body: string }): Promise<PlayerNote> {
  return ctx.db
    .insertInto('player_notes')
    .values({
      id: newId(),
      world_id: ctx.worldId,
      author_id: ctx.actor.accountId,
      body: input.body,
    })
    .returningAll()
    .executeTakeFirstOrThrow()
}

export async function listNotes(ctx: WorldContext): Promise<PlayerNote[]> {
  let q = ctx.db.selectFrom('player_notes').selectAll().where('world_id', '=', ctx.worldId)
  const scope = playerDataReadScope(ctx)
  if (scope) q = q.where('author_id', '=', scope.ownerId)
  return q.orderBy('created_at').execute()
}

export async function getNote(ctx: WorldContext, id: string): Promise<PlayerNote | undefined> {
  let q = ctx.db
    .selectFrom('player_notes')
    .selectAll()
    .where('world_id', '=', ctx.worldId)
    .where('id', '=', id)
  const scope = playerDataReadScope(ctx)
  if (scope) q = q.where('author_id', '=', scope.ownerId)
  return q.executeTakeFirst()
}

export async function updateNote(
  ctx: WorldContext,
  id: string,
  patch: { body: string },
): Promise<PlayerNote | undefined> {
  const existing = await ctx.db
    .selectFrom('player_notes')
    .select(['author_id'])
    .where('world_id', '=', ctx.worldId)
    .where('id', '=', id)
    .executeTakeFirst()
  if (!existing) return undefined
  assertPlayerDataWrite(ctx, existing.author_id)
  return ctx.db
    .updateTable('player_notes')
    .set({ body: patch.body, updated_at: NOW })
    .where('world_id', '=', ctx.worldId)
    .where('id', '=', id)
    .returningAll()
    .executeTakeFirst()
}

export async function deleteNote(ctx: WorldContext, id: string): Promise<boolean> {
  const existing = await ctx.db
    .selectFrom('player_notes')
    .select(['author_id'])
    .where('world_id', '=', ctx.worldId)
    .where('id', '=', id)
    .executeTakeFirst()
  if (!existing) return false
  assertPlayerDataWrite(ctx, existing.author_id)
  const res = await ctx.db
    .deleteFrom('player_notes')
    .where('world_id', '=', ctx.worldId)
    .where('id', '=', id)
    .executeTakeFirstOrThrow()
  return res.numDeletedRows > 0n
}
