import { type Kysely, sql } from 'kysely'

/**
 * One character model: a PC page is linked to the account that plays it, and
 * the parallel `player_characters` sheet is retired.
 *
 * ## Why there were two, and why that could not stand
 *
 * `pc` is a content kind — a DM-authored wiki page on the `entities` base table
 * with visibility, relationships, images and a `[[link]]`-able name, owner-only
 * for writes like every other content row. `player_characters` was something
 * else entirely: an account-owned row with a free-form jsonb sheet, written by
 * the player and merely readable by the DM (authz/player-data.ts).
 *
 * Neither could answer "which character is mine". The `pc` page had no account
 * on it, and the sheet had no UI at all — the Characters surface was removed
 * post-ship, leaving four live routes nothing called. So the app held two
 * half-answers to one question, and the player dashboard needs a whole one.
 *
 * The `pc` page wins because it is the one a DM already maintains, already
 * links to, and already controls the visibility of. The sheet goes.
 *
 * ## Where the link lives, and what enforces it
 *
 * `pc_details.account_id`, nullable — an unplayed PC is an ordinary thing, and
 * a world can hold NPCs-in-waiting long before anyone rolls them up.
 *
 * The reference is to `world_members`, not to `accounts` — see below — and
 * deleting an ACCOUNT still releases the character, along a chain rather than
 * directly: the account's membership row cascades away (0001), and that
 * delete is what nulls the link here. Either way the PC page survives. Nothing
 * about deleting an account should delete the DM's write-up of the character
 * they played.
 *
 * "The account must be a MEMBER of this world" is the half a plain reference to
 * `accounts` cannot carry, and it is the half that makes the link mean
 * anything. It gets a real constraint rather than a convention, because
 * `pc_details` already denormalises `world_id` (every detail table has since
 * 0005) — so the pair `(world_id, account_id)` can point straight at
 * `world_members`, whose primary key it is.
 *
 * ON DELETE SET NULL (account_id) — the column list matters. Without it
 * Postgres nulls EVERY column of the key, and `world_id` is NOT NULL, so a
 * player leaving would fail the delete instead of releasing the character.
 * Naming the column is a Postgres 15+ feature; compose pins 17.
 *
 * What that buys, beyond the guarantee: a player who leaves the world releases
 * their characters automatically, in the same statement that removes their
 * membership. `tenancy/lifecycle.ts` needs no clause for it and cannot forget
 * one. The write path still checks membership first (data/pc-account.ts), not
 * for correctness — the constraint is the correctness — but so the GM gets a
 * sentence instead of a foreign-key violation.
 *
 * ## The drop
 *
 * `player_characters` is dropped outright rather than migrated. It held no rows
 * in any known deployment, and `up` refuses to run if that turns out to be
 * false somewhere — a drop is not reversible, and a surprising row is a reason
 * to stop rather than a rounding error. `down` rebuilds the table exactly as
 * 0001 declared it; the data, if there ever were any, is not coming back, which
 * is the ordinary honesty of a destructive migration.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('pc_details').addColumn('account_id', 'text').execute()

  // Membership, as a constraint rather than a convention. Kysely's builder has
  // no spelling for the column list on SET NULL, so the constraint is raw.
  await sql`
    alter table pc_details
      add constraint pc_details_account_is_member_fkey
      foreign key (world_id, account_id)
      references world_members (world_id, account_id)
      on delete set null (account_id)
  `.execute(db)

  // "The pc this account plays in this world" reads by account and joins up to
  // `entities` for the world scope, so the account side is what needs covering.
  // Partial, because the overwhelming majority of PC pages are unlinked and an
  // index over a column of nulls is pure write cost.
  await db.schema
    .createIndex('pc_details_account_idx')
    .on('pc_details')
    .column('account_id')
    .where(sql.ref('account_id'), 'is not', null)
    .execute()

  // Refuse rather than destroy. The task that filed this migration confirmed
  // the table was empty, but "confirmed empty six days ago on one machine" and
  // "empty here, now" are different claims, and only the second one licenses a
  // DROP.
  const { rows } = await sql<{
    count: string
  }>`select count(*)::text as count from player_characters`.execute(db)
  const count = Number(rows[0]?.count ?? '0')
  if (count > 0) {
    throw new Error(
      `0018 refuses to drop player_characters: ${count} row(s) present. ` +
        'This migration assumes the surface was never used. Migrate the rows into ' +
        'pc entities first, or delete them deliberately, then re-run.',
    )
  }

  await db.schema.dropTable('player_characters').execute()
}

export async function down(db: Kysely<unknown>): Promise<void> {
  const now = sql`now()`

  // Exactly as 0001_init declared it. Reversing the schema is what `down` owes;
  // the rows are gone and no `down` can invent them.
  await db.schema
    .createTable('player_characters')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('world_id', 'text', (c) => c.notNull().references('worlds.id').onDelete('cascade'))
    .addColumn('owner_id', 'text', (c) => c.notNull().references('accounts.id').onDelete('cascade'))
    .addColumn('name', 'text', (c) => c.notNull())
    .addColumn('data', 'jsonb', (c) => c.notNull().defaultTo(sql`'{}'::jsonb`))
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(now))
    .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(now))
    .execute()

  await db.schema.dropIndex('pc_details_account_idx').execute()
  // The constraint goes with the column it is declared over.
  await db.schema.alterTable('pc_details').dropColumn('account_id').execute()
}
