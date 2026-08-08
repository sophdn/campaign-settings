import type { Kysely } from 'kysely'
import type { Database } from '../db/schema'

/**
 * Account deletion.
 *
 * RECORDED CASCADE DECISION. Deleting an account removes, by database cascade
 * off `accounts.id`:
 *
 *   auth_sessions           every session, everywhere — the account is gone
 *   password_reset_tokens   any outstanding reset token
 *   world_invitations       invitations they sent, and ones aimed at them
 *   world_members           every membership
 *   player_notes            their notes in every world
 *   player_characters       their characters in every world
 *   entity_visibility       every per-entity grant they held (FK added in 0012)
 *   suggestions             everything they proposed, accepted or not
 *   worlds.pending_owner_id nulled — an offer to a gone account is not an offer
 *
 * Suggestions go because the row is the author's own words and names them.
 * Content a DM already ACCEPTED stays in the world, because accepting merged it
 * into the entity — the campaign keeps the text, and loses the record of who
 * proposed it. That is what deleting your data means here, and the UI says so.
 *
 * OWNED WORLDS BLOCK the whole thing. Not cascade, not auto-transfer: a world
 * may contain other people's contributions, and destroying someone else's
 * campaign as a side effect of a stranger closing their account is not a
 * trade-off worth making silently. The owner transfers each world or deletes it
 * explicitly, and only then may the account go. `0012` backs this with
 * `ON DELETE RESTRICT` so the database refuses too, rather than trusting this
 * check to be the only one.
 *
 * This is a HARD delete. There is no soft-delete flag, nothing hidden-but-kept:
 * the row is gone and so is everything above.
 */

/** A world the account owns, blocking deletion until it is transferred or deleted. */
export interface BlockingWorld {
  id: string
  name: string
  slug: string
}

/** Worlds the account owns. Deletion is refused while this is non-empty. */
export async function worldsBlockingDeletion(
  db: Kysely<Database>,
  accountId: string,
): Promise<BlockingWorld[]> {
  return db
    .selectFrom('worlds')
    .select(['id', 'name', 'slug'])
    .where('owner_id', '=', accountId)
    .orderBy('name')
    .execute()
}

/** Raised when an account still owns worlds. Carries them so the UI can list them. */
export class OwnsWorldsError extends Error {
  constructor(readonly worlds: BlockingWorld[]) {
    super(
      `this account still owns ${worlds.length} world(s): transfer or delete each one before deleting the account`,
    )
    this.name = 'OwnsWorldsError'
  }
}

/**
 * Delete the account and everything cascading off it. Refuses while it owns any
 * world.
 *
 * The check and the delete run in ONE transaction so a world created between
 * the two cannot slip through. Even if it did, 0012's RESTRICT would abort the
 * delete rather than take the world with it — the transaction is the friendly
 * refusal, the constraint is the one that cannot be argued with.
 */
export async function deleteAccount(db: Kysely<Database>, accountId: string): Promise<void> {
  await db.transaction().execute(async (trx) => {
    const blocking = await worldsBlockingDeletion(trx, accountId)
    if (blocking.length > 0) throw new OwnsWorldsError(blocking)
    await trx.deleteFrom('accounts').where('id', '=', accountId).execute()
  })
}
