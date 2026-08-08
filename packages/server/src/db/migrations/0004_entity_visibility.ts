import { type Kysely, sql } from 'kysely'

/**
 * Replace the binary `dm_only` flag with a 3-state `visibility`
 * (public / dm_only / restricted) on every content table, and add the
 * entity_visibility ACL that gates `restricted` rows to specific players.
 *
 * Backfill is behavior-preserving: dm_only=true -> 'dm_only', false -> 'public'.
 * No existing row becomes 'restricted', so live data keeps its current visibility.
 */

// Every content/attachment table that carried dm_only (the ContentTableName set).
const CONTENT_TABLES = [
  'species',
  'cultures',
  'pantheons',
  'languages',
  'magic_systems',
  'currencies',
  'deities',
  'resources',
  'locations',
  'organizations',
  'items',
  'events',
  'lore_articles',
  'maps',
  'sessions',
  'npcs',
  'pcs',
  'settlements',
  'settlement_currency_attachments',
  'organization_currency_attachments',
] as const

export async function up(db: Kysely<unknown>): Promise<void> {
  for (const t of CONTENT_TABLES) {
    await db.schema
      .alterTable(t)
      .addColumn('visibility', 'text', (c) => c.notNull().defaultTo('public'))
      .execute()
    await sql`update ${sql.ref(t)} set visibility = case when dm_only then 'dm_only' else 'public' end`.execute(
      db,
    )
    await sql`alter table ${sql.ref(t)} add constraint ${sql.ref(
      `${t}_visibility_check`,
    )} check (visibility in ('public', 'dm_only', 'restricted'))`.execute(db)
    await db.schema.alterTable(t).dropColumn('dm_only').execute()
  }

  await db.schema
    .createTable('entity_visibility')
    .addColumn('world_id', 'text', (c) => c.notNull())
    .addColumn('entity_kind', 'text', (c) => c.notNull())
    .addColumn('entity_id', 'text', (c) => c.notNull())
    .addColumn('account_id', 'text', (c) => c.notNull())
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addPrimaryKeyConstraint('entity_visibility_pk', [
      'world_id',
      'entity_kind',
      'entity_id',
      'account_id',
    ])
    .execute()

  // The seam looks up grants by (world, account) while filtering an entity list.
  await db.schema
    .createIndex('entity_visibility_account_idx')
    .on('entity_visibility')
    .columns(['world_id', 'account_id'])
    .execute()
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('entity_visibility').execute()
  for (const t of CONTENT_TABLES) {
    await db.schema
      .alterTable(t)
      .addColumn('dm_only', 'boolean', (c) => c.notNull().defaultTo(false))
      .execute()
    await sql`update ${sql.ref(t)} set dm_only = (visibility = 'dm_only')`.execute(db)
    await db.schema.alterTable(t).dropColumn('visibility').execute()
  }
}
