import type { Kysely } from 'kysely'
import type { Database, MemberRole } from '../db/schema'
import type { MemberView } from './types'

/**
 * Everyone in a world, owner first then players, each side alphabetical — a
 * stable order the UI can render without sorting again.
 *
 * The projection carries the username and NOTHING else off the account: email
 * in particular stays out, exactly as `PublicAccount` keeps it out. This is the
 * one place a member learns other members' identities, so widening it here
 * would quietly publish an address list to every player in the world.
 */
export async function listMembers(db: Kysely<Database>, worldId: string): Promise<MemberView[]> {
  const rows = await db
    .selectFrom('world_members')
    .innerJoin('accounts', 'accounts.id', 'world_members.account_id')
    .where('world_members.world_id', '=', worldId)
    .select([
      'world_members.account_id as account_id',
      'world_members.role as role',
      'world_members.created_at as created_at',
      'accounts.username as username',
    ])
    // 'owner' sorts before 'player' alphabetically, which is the order we want
    // and not a coincidence worth relying on — say it explicitly.
    .orderBy(({ eb, ref }) =>
      eb.case().when(ref('world_members.role'), '=', 'owner').then(0).else(1).end(),
    )
    .orderBy('accounts.username', 'asc')
    .execute()

  return rows.map((row) => ({
    accountId: row.account_id,
    username: row.username,
    role: row.role,
    joinedAt: row.created_at,
  }))
}

/** Insert or update a membership row (idempotent grant). */
export async function upsertMember(
  db: Kysely<Database>,
  row: { world_id: string; account_id: string; role: MemberRole },
): Promise<void> {
  await db
    .insertInto('world_members')
    .values(row)
    .onConflict((oc) => oc.columns(['world_id', 'account_id']).doUpdateSet({ role: row.role }))
    .execute()
}

// NOTE: there is deliberately no bare `deleteMember` here. Dropping the
// membership row alone leaves the account's entity grants and player data
// behind, which is the defect `removeMembership` in lifecycle.ts exists to fix.
// Removing someone from a world goes through that, on every path.
