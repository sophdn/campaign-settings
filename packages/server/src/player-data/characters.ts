import { type Selectable, sql } from 'kysely'
import { assertPlayerDataWrite, playerDataReadScope } from '../authz/player-data'
import type { WorldContext } from '../data/context'
import { newId } from '../db/ids'
import { jsonb } from '../db/json'
import type { PlayerCharactersTable } from '../db/schema'

/**
 * Player characters — owned by an account, with a free-form jsonb `data` sheet.
 * Same ownership rule as notes: a player CRUDs only their own; the DM may read
 * all of a world's characters but not write another account's.
 */

export type PlayerCharacter = Selectable<PlayerCharactersTable>

const NOW = sql<Date>`now()`

export async function createCharacter(
  ctx: WorldContext,
  input: { name: string; data?: Record<string, unknown> },
): Promise<PlayerCharacter> {
  return ctx.db
    .insertInto('player_characters')
    .values({
      id: newId(),
      world_id: ctx.worldId,
      owner_id: ctx.actor.accountId,
      name: input.name,
      ...(input.data !== undefined ? { data: jsonb(input.data) } : {}),
    })
    .returningAll()
    .executeTakeFirstOrThrow()
}

export async function listCharacters(ctx: WorldContext): Promise<PlayerCharacter[]> {
  let q = ctx.db.selectFrom('player_characters').selectAll().where('world_id', '=', ctx.worldId)
  const scope = playerDataReadScope(ctx)
  if (scope) q = q.where('owner_id', '=', scope.ownerId)
  return q.orderBy('name').execute()
}

export async function getCharacter(
  ctx: WorldContext,
  id: string,
): Promise<PlayerCharacter | undefined> {
  let q = ctx.db
    .selectFrom('player_characters')
    .selectAll()
    .where('world_id', '=', ctx.worldId)
    .where('id', '=', id)
  const scope = playerDataReadScope(ctx)
  if (scope) q = q.where('owner_id', '=', scope.ownerId)
  return q.executeTakeFirst()
}

export async function updateCharacter(
  ctx: WorldContext,
  id: string,
  patch: { name?: string; data?: Record<string, unknown> },
): Promise<PlayerCharacter | undefined> {
  const existing = await ctx.db
    .selectFrom('player_characters')
    .select(['owner_id'])
    .where('world_id', '=', ctx.worldId)
    .where('id', '=', id)
    .executeTakeFirst()
  if (!existing) return undefined
  assertPlayerDataWrite(ctx, existing.owner_id)
  return ctx.db
    .updateTable('player_characters')
    .set({
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.data !== undefined ? { data: jsonb(patch.data) } : {}),
      updated_at: NOW,
    })
    .where('world_id', '=', ctx.worldId)
    .where('id', '=', id)
    .returningAll()
    .executeTakeFirst()
}

export async function deleteCharacter(ctx: WorldContext, id: string): Promise<boolean> {
  const existing = await ctx.db
    .selectFrom('player_characters')
    .select(['owner_id'])
    .where('world_id', '=', ctx.worldId)
    .where('id', '=', id)
    .executeTakeFirst()
  if (!existing) return false
  assertPlayerDataWrite(ctx, existing.owner_id)
  const res = await ctx.db
    .deleteFrom('player_characters')
    .where('world_id', '=', ctx.worldId)
    .where('id', '=', id)
    .executeTakeFirstOrThrow()
  return res.numDeletedRows > 0n
}
