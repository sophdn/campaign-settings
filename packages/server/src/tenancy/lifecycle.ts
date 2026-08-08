import type { Kysely, Transaction } from 'kysely'
import type { Database } from '../db/schema'
import { ForbiddenError, type PendingTransfer } from './types'

/**
 * Leaving a world, and handing one over.
 *
 * Two invariants hold across everything here:
 *
 *  1. **A world always has exactly one owner.** Never zero, never two, not even
 *     briefly. Transfer is therefore a single transaction that moves the
 *     `worlds.owner_id` and both `world_members.role` rows together; there is no
 *     point at which a reader could observe the world mid-swap.
 *  2. **Losing membership means losing access, on every path.** Whether the
 *     player leaves or the owner removes them, the same purge runs — a stale
 *     `entity_visibility` row would silently restore a restricted page if that
 *     person were ever re-added.
 */

/**
 * Everything that stops being theirs when someone stops being a member.
 *
 * RECORDED DECISION — player-owned notes and characters for the world are
 * DELETED, not retained. The DM can read player data for their world, so
 * retaining it would leave a departed player's private notes readable by the
 * people they walked away from. The UI offers a download of both before the
 * leave button does anything, so the choice is "take it with you", not "lose
 * it silently".
 *
 * Suggestions are deliberately NOT deleted: once a DM has accepted one it is
 * part of the world's content, and retracting it would edit someone else's
 * campaign. Authored-but-unaccepted suggestions are left too, for the same
 * reason a sent message is not unsent by leaving the room.
 */
async function purgeMembership(
  trx: Transaction<Database>,
  worldId: string,
  accountId: string,
): Promise<void> {
  await trx
    .deleteFrom('entity_visibility')
    .where('world_id', '=', worldId)
    .where('account_id', '=', accountId)
    .execute()
  await trx
    .deleteFrom('player_notes')
    .where('world_id', '=', worldId)
    .where('author_id', '=', accountId)
    .execute()
  await trx
    .deleteFrom('player_characters')
    .where('world_id', '=', worldId)
    .where('owner_id', '=', accountId)
    .execute()
  await trx
    .deleteFrom('world_members')
    .where('world_id', '=', worldId)
    .where('account_id', '=', accountId)
    .execute()
  // An outstanding offer to someone who is no longer a member is not an offer.
  await trx
    .updateTable('worlds')
    .set({ pending_owner_id: null })
    .where('id', '=', worldId)
    .where('pending_owner_id', '=', accountId)
    .execute()
}

/** Drop a membership and everything that came with it. Used by leave AND revoke. */
export async function removeMembership(
  db: Kysely<Database>,
  worldId: string,
  accountId: string,
): Promise<void> {
  await db.transaction().execute((trx) => purgeMembership(trx, worldId, accountId))
}

/**
 * Leave a world under your own steam. The OWNER cannot: a world may never be
 * ownerless, so their exits are transfer-then-leave, or delete. The refusal
 * names which, rather than a bare 403 — the caller has two real options and the
 * API should say so.
 */
export async function leaveWorld(
  db: Kysely<Database>,
  worldId: string,
  accountId: string,
): Promise<void> {
  const membership = await db
    .selectFrom('world_members')
    .select('role')
    .where('world_id', '=', worldId)
    .where('account_id', '=', accountId)
    .executeTakeFirst()
  if (!membership) throw new ForbiddenError(worldId)
  if (membership.role === 'owner') {
    throw new OwnerCannotLeaveError(worldId)
  }
  await removeMembership(db, worldId, accountId)
}

/** Raised when an owner tries to leave their own world. Carries its own remedy. */
export class OwnerCannotLeaveError extends Error {
  constructor(worldId: string) {
    super(
      `the owner cannot leave world ${worldId}: transfer ownership to another member first, or delete the world`,
    )
    this.name = 'OwnerCannotLeaveError'
  }
}

/** Raised when a transfer names someone who is not a member of the world. */
export class NotAMemberError extends Error {
  constructor(worldId: string) {
    super(`ownership can only be transferred to an existing member of world ${worldId}`)
    this.name = 'NotAMemberError'
  }
}

/**
 * Offer the world to an existing member. This does NOT transfer anything — it
 * records the offer, and the named account accepts it. See the 0011 migration
 * for why confirmation is required rather than optional.
 */
export async function offerOwnership(
  db: Kysely<Database>,
  worldId: string,
  toAccountId: string,
): Promise<void> {
  const member = await db
    .selectFrom('world_members')
    .select('role')
    .where('world_id', '=', worldId)
    .where('account_id', '=', toAccountId)
    .executeTakeFirst()
  // Offering it to a non-member would either be a no-op the owner thinks
  // worked, or an invitation wearing the wrong hat. Refuse it.
  if (!member) throw new NotAMemberError(worldId)
  if (member.role === 'owner') throw new NotAMemberError(worldId)
  await db
    .updateTable('worlds')
    .set({ pending_owner_id: toAccountId })
    .where('id', '=', worldId)
    .execute()
}

/** Withdraw an outstanding offer. Idempotent — no offer is already the goal. */
export async function cancelOwnershipOffer(db: Kysely<Database>, worldId: string): Promise<void> {
  await db.updateTable('worlds').set({ pending_owner_id: null }).where('id', '=', worldId).execute()
}

/** The outstanding offer for a world, with the recipient's name, or null. */
export async function getPendingTransfer(
  db: Kysely<Database>,
  worldId: string,
): Promise<PendingTransfer | null> {
  const row = await db
    .selectFrom('worlds')
    .innerJoin('accounts', 'accounts.id', 'worlds.pending_owner_id')
    .where('worlds.id', '=', worldId)
    .select(['accounts.id as account_id', 'accounts.username as username'])
    .executeTakeFirst()
  return row ? { accountId: row.account_id, username: row.username } : null
}

/**
 * Accept an outstanding offer, as the account it names. The whole swap is ONE
 * transaction over a locked world row:
 *
 *   worlds.owner_id        -> the accepter
 *   worlds.pending_owner_id -> null
 *   the accepter's member row -> 'owner'
 *   the old owner's member row -> 'player'
 *
 * The `FOR UPDATE` lock plus re-reading `pending_owner_id` inside the
 * transaction is what makes two simultaneous accepts safe: the loser re-reads a
 * cleared column and is refused, rather than both writing an owner.
 *
 * The old owner becomes a PLAYER rather than being removed. Removing them would
 * destroy their notes and characters (see `purgeMembership`) as a side effect of
 * handing over the reins, which is not what "transfer" means to anyone.
 */
export async function acceptOwnership(
  db: Kysely<Database>,
  worldId: string,
  accepterId: string,
): Promise<void> {
  await db.transaction().execute(async (trx) => {
    const world = await trx
      .selectFrom('worlds')
      .select(['owner_id', 'pending_owner_id'])
      .where('id', '=', worldId)
      .forUpdate()
      .executeTakeFirst()
    if (!world || world.pending_owner_id !== accepterId) throw new ForbiddenError(worldId)

    await trx
      .updateTable('worlds')
      .set({ owner_id: accepterId, pending_owner_id: null })
      .where('id', '=', worldId)
      .execute()
    await trx
      .updateTable('world_members')
      .set({ role: 'owner' })
      .where('world_id', '=', worldId)
      .where('account_id', '=', accepterId)
      .execute()
    await trx
      .updateTable('world_members')
      .set({ role: 'player' })
      .where('world_id', '=', worldId)
      .where('account_id', '=', world.owner_id)
      .execute()
  })
}
