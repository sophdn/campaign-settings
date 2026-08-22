import type { Kysely } from 'kysely'

/**
 * Ownership transfer: a nullable `worlds.pending_owner_id` naming the member the
 * current owner has offered the world to.
 *
 * A COLUMN rather than a table, deliberately. A world can have at most one
 * outstanding offer, and a nullable column says exactly that — a table would
 * need a partial unique index to express the same bound and would invite a
 * history the product does not have a use for. Cancelling is setting it back to
 * NULL; there is no `cancelled` state to store and no sweeper to keep honest.
 *
 * Transfer is CONFIRMED BY THE RECIPIENT: setting this column is an offer, not
 * the transfer. Nothing about ownership moves until the named account accepts,
 * because an owner cannot leave a world — so an imposed transfer would trap the
 * recipient in a role they never agreed to.
 *
 * `ON DELETE SET NULL`: if the offered-to account is deleted, the offer
 * evaporates and the world keeps its current owner. Cascading the world away
 * because a prospective owner closed their account would be catastrophic and is
 * exactly the shape of accident this constraint exists to rule out.
 *
 * Behavior-preserving: the column is nullable with no default, so every existing
 * world reads NULL — no world has a pending transfer, which is the truth.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('worlds')
    .addColumn('pending_owner_id', 'text', (c) => c.references('accounts.id').onDelete('set null'))
    .execute()
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('worlds').dropColumn('pending_owner_id').execute()
}
