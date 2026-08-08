import { assertContentWrite } from '../authz/content'
import type { WorldContext } from './context'

/**
 * The per-player visibility ACL for `restricted` content rows: a player sees a
 * restricted entity only if they hold a matching grant. Keyed by (world, entity
 * id, account) — the entity id alone identifies the entity since 0005 (its kind
 * lives on entities.kind). All operations are owner-only and world-scoped; the
 * authorization seam consumes these grants on every read.
 */

export async function grantEntityVisibility(
  ctx: WorldContext,
  entityId: string,
  accountId: string,
): Promise<void> {
  assertContentWrite(ctx)
  await ctx.db
    .insertInto('entity_visibility')
    .values({
      world_id: ctx.worldId,
      entity_id: entityId,
      account_id: accountId,
    })
    .onConflict((oc) => oc.columns(['world_id', 'entity_id', 'account_id']).doNothing())
    .execute()
}

export async function revokeEntityVisibility(
  ctx: WorldContext,
  entityId: string,
  accountId: string,
): Promise<void> {
  assertContentWrite(ctx)
  await ctx.db
    .deleteFrom('entity_visibility')
    .where('world_id', '=', ctx.worldId)
    .where('entity_id', '=', entityId)
    .where('account_id', '=', accountId)
    .execute()
}

/** The account ids currently granted access to a restricted entity (owner-only). */
export async function listEntityGrants(ctx: WorldContext, entityId: string): Promise<string[]> {
  assertContentWrite(ctx)
  const rows = await ctx.db
    .selectFrom('entity_visibility')
    .select('account_id')
    .where('world_id', '=', ctx.worldId)
    .where('entity_id', '=', entityId)
    .execute()
  return rows.map((r) => r.account_id)
}
