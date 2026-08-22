import { type Kysely, sql } from 'kysely'

/**
 * At most one PC page per player, per world.
 *
 * 0018 left this open on the reasoning that a player whose character died and
 * who rolled a second holds two, so a unique constraint would ask the GM to
 * delete the dead one to record the living one. The decision went the other
 * way (Sophi, 2026-08-18): the link means "this is who you are playing", the
 * dashboard's "my character" is a singular question, and a retired character is
 * better recorded by CLEARING its link than by holding a second live one. A
 * dead PC's page keeps its name, prose, relationships and images — it stops
 * claiming a seat at the table, which is what leaving it linked would assert.
 *
 * A PARTIAL unique index rather than a table constraint, for the null. Postgres
 * treats nulls as distinct in a unique index, so a plain constraint would
 * already permit any number of unlinked PCs — but saying so explicitly costs
 * nothing and keeps the index off the rows that are overwhelmingly the common
 * case. `WHERE account_id IS NOT NULL` is the whole rule in one clause.
 *
 * It REPLACES `pc_details_account_idx` from 0018 rather than sitting beside it.
 * That index covered `(account_id)`; this one leads with `world_id`, which is
 * how the link is actually read — "who does this account play IN THIS WORLD" —
 * and a second index over the same rows for the same query would be write cost
 * with no reader.
 *
 * `data/pc-account.ts` checks first, as it does for membership, so a GM who
 * links a second character gets a sentence naming the one already linked rather
 * than a unique-violation 500. The index is the guarantee; the check is the
 * explanation.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  // Nothing to reconcile: 0018 shipped hours ago and the column starts null
  // everywhere. Asserting it anyway, because a unique index that fails halfway
  // through a deploy is a worse way to learn the data disagreed.
  const { rows } = await sql<{ world_id: string; account_id: string; n: string }>`
    select world_id, account_id, count(*)::text as n
    from pc_details
    where account_id is not null
    group by world_id, account_id
    having count(*) > 1
  `.execute(db)
  if (rows.length > 0) {
    const where = rows.map((r) => `${r.n} in world ${r.world_id}`).join('; ')
    throw new Error(
      `0019 cannot enforce one PC per player: some players already hold several (${where}). ` +
        'Clear the link on the retired characters, then re-run.',
    )
  }

  await db.schema.dropIndex('pc_details_account_idx').execute()
  await db.schema
    .createIndex('pc_details_one_pc_per_player')
    .unique()
    .on('pc_details')
    .columns(['world_id', 'account_id'])
    .where(sql.ref('account_id'), 'is not', null)
    .execute()
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropIndex('pc_details_one_pc_per_player').execute()
  await db.schema
    .createIndex('pc_details_account_idx')
    .on('pc_details')
    .column('account_id')
    .where(sql.ref('account_id'), 'is not', null)
    .execute()
}
