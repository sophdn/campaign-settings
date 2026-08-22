import type { Kysely } from 'kysely'
import type { WorldContext } from '../data/context'
import type { Database } from '../db/schema'

/**
 * THE membership gate. A world-scoped data handle is obtainable ONLY by
 * resolving it through this function, which checks `world_members` for the
 * actor's role in the world. A non-member resolves to null — no context, no
 * access to anything — so cross-tenant reach (an actor of world A asking for
 * world B) is structurally impossible, not a per-endpoint check.
 *
 * The world is addressed by its `slug` (the URL key); the resolved context
 * carries the real `worldId`, so every downstream query stays keyed by id.
 */
export async function resolveWorldContext(
  db: Kysely<Database>,
  accountId: string,
  slug: string,
): Promise<WorldContext | null> {
  const row = await db
    .selectFrom('world_members')
    .innerJoin('worlds', 'worlds.id', 'world_members.world_id')
    .select(['worlds.id as worldId', 'world_members.role as role'])
    .where('worlds.slug', '=', slug)
    .where('world_members.account_id', '=', accountId)
    .executeTakeFirst()
  if (!row) return null
  return { db, worldId: row.worldId, actor: { accountId, role: row.role } }
}
