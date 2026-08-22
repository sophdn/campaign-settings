import { type Kysely, sql } from 'kysely'

/**
 * Per-player grants for `restricted` MAPS.
 *
 * Maps were the one place the visibility model did not work the same way as
 * everywhere else: `maps.visibility` accepted `public` and `dm_only`, and the
 * route REFUSED `restricted`. That refusal was correct rather than lazy —
 * `entity_visibility.entity_id` is foreign-keyed to `entities` (migration
 * 0005), a map lives in its own table, and a grant naming one could not be
 * stored. Accepting the value would have sold the DM something shareable that
 * behaved exactly like `dm_only`.
 *
 * ## Why a parallel table, and why this is now a small change
 *
 * When this limitation was filed it looked expensive: the alternatives were to
 * drop `entity_visibility`'s foreign key for a polymorphic (kind, id) key, or
 * add a second ACL — and BOTH were described as touching the one table the
 * whole per-player visibility claim rests on.
 *
 * That is no longer true. The seam now takes its ACL as a PARAMETER
 * (`GrantTableSpec` in authz/content.ts), so a second ACL table is not a second
 * copy of the visibility decision — the same `visible()` reads from it, and
 * `entity_visibility` is not touched at all. A polymorphic key would still cost
 * the foreign key, and this schema keeps those deliberately.
 *
 * So: one more table, shaped exactly like `passage_visibility`, and one option
 * on the map repo. The single-seam story is unchanged — there is still exactly
 * one place the per-player read filter lives.
 *
 * ## What this does NOT change
 *
 * The per-PIN filter still applies on top. A player granted a map still does
 * not see pins whose TARGET entity they cannot see: `data/map-pins.ts` resolves
 * every pin's entity through the seam and drops the row whole. Sharing a map
 * shares the map, not what is on it.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('map_visibility')
    .addColumn('world_id', 'text', (c) => c.notNull().references('worlds.id').onDelete('cascade'))
    .addColumn('map_id', 'text', (c) => c.notNull().references('maps.id').onDelete('cascade'))
    // CASCADE, matching entity_visibility since 0012: a grant is meaningless
    // without the account it names.
    .addColumn('account_id', 'text', (c) =>
      c.notNull().references('accounts.id').onDelete('cascade'),
    )
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addPrimaryKeyConstraint('map_visibility_pk', ['world_id', 'map_id', 'account_id'])
    .execute()

  // The seam looks grants up by (world, account) while filtering a map list.
  await db.schema
    .createIndex('map_visibility_account_idx')
    .on('map_visibility')
    .columns(['world_id', 'account_id'])
    .execute()
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('map_visibility').execute()
}
