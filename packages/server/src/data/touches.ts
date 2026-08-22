import { type Selectable, sql } from 'kysely'
import { assertContentWrite } from '../authz/content'
import { newId } from '../db/ids'
import type { EntityTouchesTable } from '../db/schema'
import type { WorldContext } from './context'

/**
 * Entity touches — the structured interaction records a session captures
 * ("the party MET this NPC", "KILLED that monster"). Unlike content entities,
 * the touch row has no `dm_only` column: a touch's visibility is its endpoints'
 * (the session + the touched entity), enforced where touches are READ for the
 * graph / history by intersecting with the authorized entity + session sets.
 * Writes are owner-only, the same gate content writes use.
 */

/** The closed touch-type vocabulary (mirrors dm-manager). */
export const TOUCH_TYPES = ['met', 'affected', 'killed', 'discussed', 'other'] as const
export type TouchType = (typeof TOUCH_TYPES)[number]

export type Touch = Selectable<EntityTouchesTable>

export interface NewTouch {
  session_id: string
  entity_id: string
  touch_type: TouchType
  narrative_delta?: string
}

const NOW = sql<Date>`now()`

/** Touches recorded for one session (world-scoped, live rows). Member-read. */
export async function listTouchesForSession(
  ctx: WorldContext,
  sessionId: string,
): Promise<Touch[]> {
  return ctx.db
    .selectFrom('entity_touches')
    .selectAll()
    .where('world_id', '=', ctx.worldId)
    .where('session_id', '=', sessionId)
    .where('deleted_at', 'is', null)
    .orderBy('created_at')
    .execute()
}

/** Every live touch in the world — the graph + per-entity-history input. */
export async function listTouches(ctx: WorldContext): Promise<Touch[]> {
  return ctx.db
    .selectFrom('entity_touches')
    .selectAll()
    .where('world_id', '=', ctx.worldId)
    .where('deleted_at', 'is', null)
    .execute()
}

/** Record a touch (owner-only). */
export async function createTouch(ctx: WorldContext, input: NewTouch): Promise<Touch> {
  assertContentWrite(ctx)
  return ctx.db
    .insertInto('entity_touches')
    .values({
      id: newId(),
      world_id: ctx.worldId,
      session_id: input.session_id,
      entity_id: input.entity_id,
      touch_type: input.touch_type,
      narrative_delta: input.narrative_delta ?? '',
    })
    .returningAll()
    .executeTakeFirstOrThrow()
}

/** Soft-delete a touch (owner-only); returns whether a live row was removed. */
export async function deleteTouch(ctx: WorldContext, id: string): Promise<boolean> {
  assertContentWrite(ctx)
  const res = await ctx.db
    .updateTable('entity_touches')
    .set({ deleted_at: NOW })
    .where('world_id', '=', ctx.worldId)
    .where('id', '=', id)
    .where('deleted_at', 'is', null)
    .executeTakeFirstOrThrow()
  return res.numUpdatedRows > 0n
}
