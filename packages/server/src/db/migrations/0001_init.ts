import { type Kysely, type SqlBool, sql } from 'kysely'

const now = sql`now()`

export async function up(db: Kysely<unknown>): Promise<void> {
  // ── net-new auth / tenancy ──────────────────────────────────────────────
  await db.schema
    .createTable('accounts')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('username', 'text', (c) => c.notNull().unique())
    .addColumn('password_hash', 'text', (c) => c.notNull())
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(now))
    .execute()

  await db.schema
    .createTable('auth_sessions')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('account_id', 'text', (c) =>
      c.notNull().references('accounts.id').onDelete('cascade'),
    )
    .addColumn('expires_at', 'timestamptz', (c) => c.notNull())
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(now))
    .execute()

  await db.schema
    .createTable('worlds')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('owner_id', 'text', (c) => c.notNull().references('accounts.id').onDelete('cascade'))
    .addColumn('name', 'text', (c) => c.notNull())
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(now))
    .execute()

  await db.schema
    .createTable('world_members')
    .addColumn('world_id', 'text', (c) => c.notNull().references('worlds.id').onDelete('cascade'))
    .addColumn('account_id', 'text', (c) =>
      c.notNull().references('accounts.id').onDelete('cascade'),
    )
    .addColumn('role', 'text', (c) => c.notNull())
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(now))
    .addPrimaryKeyConstraint('world_members_pkey', ['world_id', 'account_id'])
    .addCheckConstraint('world_members_role_check', sql`role in ('owner', 'player')`)
    .execute()

  // ── base entities (no entity-FKs) ───────────────────────────────────────
  await db.schema
    .createTable('species')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('world_id', 'text', (c) => c.notNull().references('worlds.id').onDelete('cascade'))
    .addColumn('name', 'text', (c) => c.notNull())
    .addColumn('kingdom', 'text', (c) => c.notNull().defaultTo(''))
    .addColumn('elemental_alignment', 'text')
    .addColumn('is_corporeal', 'boolean', (c) => c.notNull().defaultTo(true))
    .addColumn('is_sentient', 'boolean', (c) => c.notNull().defaultTo(true))
    .addColumn('description', 'text', (c) => c.notNull().defaultTo(''))
    .addColumn('dm_only', 'boolean', (c) => c.notNull().defaultTo(false))
    .addColumn('imported_metadata', 'jsonb')
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(now))
    .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(now))
    .addColumn('deleted_at', 'timestamptz')
    .execute()

  await db.schema
    .createTable('cultures')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('world_id', 'text', (c) => c.notNull().references('worlds.id').onDelete('cascade'))
    .addColumn('name', 'text', (c) => c.notNull())
    .addColumn('dominant_values', 'text', (c) => c.notNull().defaultTo(''))
    .addColumn('historical_period', 'text', (c) => c.notNull().defaultTo(''))
    .addColumn('aesthetic_notes', 'text', (c) => c.notNull().defaultTo(''))
    .addColumn('description', 'text', (c) => c.notNull().defaultTo(''))
    .addColumn('dm_only', 'boolean', (c) => c.notNull().defaultTo(false))
    .addColumn('imported_metadata', 'jsonb')
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(now))
    .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(now))
    .addColumn('deleted_at', 'timestamptz')
    .execute()

  await db.schema
    .createTable('pantheons')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('world_id', 'text', (c) => c.notNull().references('worlds.id').onDelete('cascade'))
    .addColumn('name', 'text', (c) => c.notNull())
    .addColumn('tradition', 'text', (c) => c.notNull().defaultTo(''))
    .addColumn('historical_period', 'text', (c) => c.notNull().defaultTo(''))
    .addColumn('description', 'text', (c) => c.notNull().defaultTo(''))
    .addColumn('dm_only', 'boolean', (c) => c.notNull().defaultTo(false))
    .addColumn('imported_metadata', 'jsonb')
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(now))
    .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(now))
    .addColumn('deleted_at', 'timestamptz')
    .execute()

  await db.schema
    .createTable('languages')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('world_id', 'text', (c) => c.notNull().references('worlds.id').onDelete('cascade'))
    .addColumn('name', 'text', (c) => c.notNull())
    .addColumn('family', 'text', (c) => c.notNull().defaultTo(''))
    .addColumn('is_trade_language', 'boolean', (c) => c.notNull().defaultTo(false))
    .addColumn('writing_system', 'text', (c) => c.notNull().defaultTo(''))
    .addColumn('description', 'text', (c) => c.notNull().defaultTo(''))
    .addColumn('dm_only', 'boolean', (c) => c.notNull().defaultTo(false))
    .addColumn('imported_metadata', 'jsonb')
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(now))
    .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(now))
    .addColumn('deleted_at', 'timestamptz')
    .execute()

  await db.schema
    .createTable('magic_systems')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('world_id', 'text', (c) => c.notNull().references('worlds.id').onDelete('cascade'))
    .addColumn('name', 'text', (c) => c.notNull())
    .addColumn('source_kind', 'text', (c) => c.notNull().defaultTo(''))
    .addColumn('cost_summary', 'text', (c) => c.notNull().defaultTo(''))
    .addColumn('alignment', 'text', (c) => c.notNull().defaultTo(''))
    .addColumn('is_taught', 'boolean', (c) => c.notNull().defaultTo(false))
    .addColumn('requires_materials', 'boolean', (c) => c.notNull().defaultTo(false))
    .addColumn('description', 'text', (c) => c.notNull().defaultTo(''))
    .addColumn('dm_only', 'boolean', (c) => c.notNull().defaultTo(false))
    .addColumn('imported_metadata', 'jsonb')
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(now))
    .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(now))
    .addColumn('deleted_at', 'timestamptz')
    .execute()

  await db.schema
    .createTable('currencies')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('world_id', 'text', (c) => c.notNull().references('worlds.id').onDelete('cascade'))
    .addColumn('name', 'text', (c) => c.notNull())
    .addColumn('symbol', 'text', (c) => c.notNull().defaultTo(''))
    .addColumn('denominations', 'jsonb', (c) => c.notNull().defaultTo(sql`'[]'::jsonb`))
    .addColumn('base_rate_to', 'text', (c) => c.references('currencies.id'))
    .addColumn('rate', sql`double precision`)
    .addColumn('description', 'text', (c) => c.notNull().defaultTo(''))
    .addColumn('dm_only', 'boolean', (c) => c.notNull().defaultTo(false))
    .addColumn('imported_metadata', 'jsonb')
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(now))
    .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(now))
    .addColumn('deleted_at', 'timestamptz')
    .execute()

  await db.schema
    .createTable('deities')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('world_id', 'text', (c) => c.notNull().references('worlds.id').onDelete('cascade'))
    .addColumn('name', 'text', (c) => c.notNull())
    .addColumn('domain', 'text', (c) => c.notNull().defaultTo(''))
    .addColumn('worship_status', 'text', (c) => c.notNull().defaultTo(''))
    .addColumn('pantheon_id', 'text', (c) => c.references('pantheons.id').onDelete('set null'))
    .addColumn('description', 'text', (c) => c.notNull().defaultTo(''))
    .addColumn('dm_only', 'boolean', (c) => c.notNull().defaultTo(false))
    .addColumn('imported_metadata', 'jsonb')
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(now))
    .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(now))
    .addColumn('deleted_at', 'timestamptz')
    .execute()

  await db.schema
    .createTable('resources')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('world_id', 'text', (c) => c.notNull().references('worlds.id').onDelete('cascade'))
    .addColumn('name', 'text', (c) => c.notNull())
    .addColumn('resource_kind', 'text', (c) => c.notNull().defaultTo(''))
    .addColumn('scarcity', 'text', (c) => c.notNull().defaultTo(''))
    .addColumn('commercial_value', 'text', (c) => c.notNull().defaultTo(''))
    .addColumn('description', 'text', (c) => c.notNull().defaultTo(''))
    .addColumn('dm_only', 'boolean', (c) => c.notNull().defaultTo(false))
    .addColumn('imported_metadata', 'jsonb')
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(now))
    .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(now))
    .addColumn('deleted_at', 'timestamptz')
    .execute()

  await db.schema
    .createTable('locations')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('world_id', 'text', (c) => c.notNull().references('worlds.id').onDelete('cascade'))
    .addColumn('name', 'text', (c) => c.notNull())
    .addColumn('description', 'text', (c) => c.notNull().defaultTo(''))
    .addColumn('dm_only', 'boolean', (c) => c.notNull().defaultTo(false))
    .addColumn('imported_metadata', 'jsonb')
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(now))
    .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(now))
    .addColumn('deleted_at', 'timestamptz')
    .execute()

  await db.schema
    .createTable('organizations')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('world_id', 'text', (c) => c.notNull().references('worlds.id').onDelete('cascade'))
    .addColumn('name', 'text', (c) => c.notNull())
    .addColumn('description', 'text', (c) => c.notNull().defaultTo(''))
    .addColumn('dm_only', 'boolean', (c) => c.notNull().defaultTo(false))
    .addColumn('imported_metadata', 'jsonb')
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(now))
    .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(now))
    .addColumn('deleted_at', 'timestamptz')
    .execute()

  await db.schema
    .createTable('items')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('world_id', 'text', (c) => c.notNull().references('worlds.id').onDelete('cascade'))
    .addColumn('name', 'text', (c) => c.notNull())
    .addColumn('description', 'text', (c) => c.notNull().defaultTo(''))
    .addColumn('dm_only', 'boolean', (c) => c.notNull().defaultTo(false))
    .addColumn('imported_metadata', 'jsonb')
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(now))
    .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(now))
    .addColumn('deleted_at', 'timestamptz')
    .execute()

  await db.schema
    .createTable('events')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('world_id', 'text', (c) => c.notNull().references('worlds.id').onDelete('cascade'))
    .addColumn('name', 'text', (c) => c.notNull())
    .addColumn('description', 'text', (c) => c.notNull().defaultTo(''))
    .addColumn('occurred_at', 'text')
    .addColumn('dm_only', 'boolean', (c) => c.notNull().defaultTo(false))
    .addColumn('imported_metadata', 'jsonb')
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(now))
    .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(now))
    .addColumn('deleted_at', 'timestamptz')
    .execute()

  await db.schema
    .createTable('lore_articles')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('world_id', 'text', (c) => c.notNull().references('worlds.id').onDelete('cascade'))
    .addColumn('name', 'text', (c) => c.notNull())
    .addColumn('description', 'text', (c) => c.notNull().defaultTo(''))
    .addColumn('kind', 'text')
    .addColumn('dm_only', 'boolean', (c) => c.notNull().defaultTo(false))
    .addColumn('imported_metadata', 'jsonb')
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(now))
    .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(now))
    .addColumn('deleted_at', 'timestamptz')
    .execute()

  await db.schema
    .createTable('maps')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('world_id', 'text', (c) => c.notNull().references('worlds.id').onDelete('cascade'))
    .addColumn('name', 'text', (c) => c.notNull())
    .addColumn('description', 'text', (c) => c.notNull().defaultTo(''))
    .addColumn('dm_only', 'boolean', (c) => c.notNull().defaultTo(false))
    .addColumn('image_path', 'text')
    .addColumn('thumbnail_path', 'text')
    .addColumn('source_width', 'integer')
    .addColumn('source_height', 'integer')
    .addColumn('imported_metadata', 'jsonb')
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(now))
    .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(now))
    .addColumn('deleted_at', 'timestamptz')
    .execute()

  await db.schema
    .createTable('calendars')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('world_id', 'text', (c) => c.notNull().references('worlds.id').onDelete('cascade'))
    .addColumn('name', 'text', (c) => c.notNull())
    .addColumn('kind', 'text', (c) => c.notNull())
    .addColumn('config', 'jsonb', (c) => c.notNull().defaultTo(sql`'{}'::jsonb`))
    .addColumn('is_active', 'boolean', (c) => c.notNull().defaultTo(false))
    .addColumn('is_user_defined', 'boolean', (c) => c.notNull().defaultTo(false))
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(now))
    .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(now))
    .addCheckConstraint('calendars_kind_check', sql`kind in ('gregorian', 'custom')`)
    .execute()

  await db.schema
    .createTable('sessions')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('world_id', 'text', (c) => c.notNull().references('worlds.id').onDelete('cascade'))
    .addColumn('name', 'text', (c) => c.notNull())
    .addColumn('played_at', 'text')
    .addColumn('captured_text', 'text', (c) => c.notNull().defaultTo(''))
    .addColumn('dm_only', 'boolean', (c) => c.notNull().defaultTo(false))
    .addColumn('imported_metadata', 'jsonb')
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(now))
    .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(now))
    .addColumn('deleted_at', 'timestamptz')
    .execute()

  // ── entities with entity-FKs ────────────────────────────────────────────
  await db.schema
    .createTable('npcs')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('world_id', 'text', (c) => c.notNull().references('worlds.id').onDelete('cascade'))
    .addColumn('name', 'text', (c) => c.notNull())
    .addColumn('description', 'text', (c) => c.notNull().defaultTo(''))
    .addColumn('dm_only', 'boolean', (c) => c.notNull().defaultTo(false))
    .addColumn('imported_metadata', 'jsonb')
    .addColumn('species_id', 'text', (c) => c.references('species.id'))
    .addColumn('culture_id', 'text', (c) => c.references('cultures.id'))
    .addColumn('occupation', 'text', (c) => c.notNull().defaultTo(''))
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(now))
    .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(now))
    .addColumn('deleted_at', 'timestamptz')
    .execute()

  await db.schema
    .createTable('pcs')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('world_id', 'text', (c) => c.notNull().references('worlds.id').onDelete('cascade'))
    .addColumn('name', 'text', (c) => c.notNull())
    .addColumn('description', 'text', (c) => c.notNull().defaultTo(''))
    .addColumn('imported_metadata', 'jsonb')
    .addColumn('species_id', 'text', (c) => c.references('species.id'))
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(now))
    .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(now))
    .addColumn('deleted_at', 'timestamptz')
    .execute()

  await db.schema
    .createTable('settlements')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('world_id', 'text', (c) => c.notNull().references('worlds.id').onDelete('cascade'))
    .addColumn('name', 'text', (c) => c.notNull())
    .addColumn('description', 'text', (c) => c.notNull().defaultTo(''))
    .addColumn('dm_only', 'boolean', (c) => c.notNull().defaultTo(false))
    .addColumn('imported_metadata', 'jsonb')
    .addColumn('culture_id', 'text', (c) => c.references('cultures.id'))
    .addColumn('size', 'text', (c) => c.notNull().defaultTo(''))
    .addColumn('wealth', 'text', (c) => c.notNull().defaultTo(''))
    .addColumn('terrain', 'text', (c) => c.notNull().defaultTo(''))
    .addColumn('population', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(now))
    .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(now))
    .addColumn('deleted_at', 'timestamptz')
    .execute()

  // ── junctions ───────────────────────────────────────────────────────────
  await db.schema
    .createTable('culture_languages')
    .addColumn('world_id', 'text', (c) => c.notNull().references('worlds.id').onDelete('cascade'))
    .addColumn('culture_id', 'text', (c) =>
      c.notNull().references('cultures.id').onDelete('cascade'),
    )
    .addColumn('language_id', 'text', (c) =>
      c.notNull().references('languages.id').onDelete('cascade'),
    )
    .addColumn('role', 'text', (c) => c.notNull())
    .addPrimaryKeyConstraint('culture_languages_pkey', ['culture_id', 'language_id'])
    .addCheckConstraint(
      'culture_languages_role_check',
      sql`role in ('native', 'secondary', 'liturgical')`,
    )
    .execute()

  await db.schema
    .createTable('culture_magic_systems')
    .addColumn('world_id', 'text', (c) => c.notNull().references('worlds.id').onDelete('cascade'))
    .addColumn('culture_id', 'text', (c) =>
      c.notNull().references('cultures.id').onDelete('cascade'),
    )
    .addColumn('magic_system_id', 'text', (c) =>
      c.notNull().references('magic_systems.id').onDelete('cascade'),
    )
    .addPrimaryKeyConstraint('culture_magic_systems_pkey', ['culture_id', 'magic_system_id'])
    .execute()

  await db.schema
    .createTable('culture_pantheons')
    .addColumn('world_id', 'text', (c) => c.notNull().references('worlds.id').onDelete('cascade'))
    .addColumn('culture_id', 'text', (c) =>
      c.notNull().references('cultures.id').onDelete('cascade'),
    )
    .addColumn('pantheon_id', 'text', (c) =>
      c.notNull().references('pantheons.id').onDelete('cascade'),
    )
    .addPrimaryKeyConstraint('culture_pantheons_pkey', ['culture_id', 'pantheon_id'])
    .execute()

  await db.schema
    .createTable('npc_languages')
    .addColumn('world_id', 'text', (c) => c.notNull().references('worlds.id').onDelete('cascade'))
    .addColumn('npc_id', 'text', (c) => c.notNull().references('npcs.id').onDelete('cascade'))
    .addColumn('language_id', 'text', (c) =>
      c.notNull().references('languages.id').onDelete('cascade'),
    )
    .addColumn('role', 'text', (c) => c.notNull())
    .addPrimaryKeyConstraint('npc_languages_pkey', ['npc_id', 'language_id'])
    .addCheckConstraint('npc_languages_role_check', sql`role in ('native', 'secondary', 'trade')`)
    .execute()

  await db.schema
    .createTable('npc_magic_systems')
    .addColumn('world_id', 'text', (c) => c.notNull().references('worlds.id').onDelete('cascade'))
    .addColumn('npc_id', 'text', (c) => c.notNull().references('npcs.id').onDelete('cascade'))
    .addColumn('magic_system_id', 'text', (c) =>
      c.notNull().references('magic_systems.id').onDelete('cascade'),
    )
    .addPrimaryKeyConstraint('npc_magic_systems_pkey', ['npc_id', 'magic_system_id'])
    .execute()

  await db.schema
    .createTable('pc_languages')
    .addColumn('world_id', 'text', (c) => c.notNull().references('worlds.id').onDelete('cascade'))
    .addColumn('pc_id', 'text', (c) => c.notNull().references('pcs.id').onDelete('cascade'))
    .addColumn('language_id', 'text', (c) =>
      c.notNull().references('languages.id').onDelete('cascade'),
    )
    .addColumn('role', 'text', (c) => c.notNull())
    .addPrimaryKeyConstraint('pc_languages_pkey', ['pc_id', 'language_id'])
    .addCheckConstraint('pc_languages_role_check', sql`role in ('native', 'secondary', 'trade')`)
    .execute()

  await db.schema
    .createTable('pc_magic_systems')
    .addColumn('world_id', 'text', (c) => c.notNull().references('worlds.id').onDelete('cascade'))
    .addColumn('pc_id', 'text', (c) => c.notNull().references('pcs.id').onDelete('cascade'))
    .addColumn('magic_system_id', 'text', (c) =>
      c.notNull().references('magic_systems.id').onDelete('cascade'),
    )
    .addPrimaryKeyConstraint('pc_magic_systems_pkey', ['pc_id', 'magic_system_id'])
    .execute()

  await db.schema
    .createTable('settlement_languages')
    .addColumn('world_id', 'text', (c) => c.notNull().references('worlds.id').onDelete('cascade'))
    .addColumn('settlement_id', 'text', (c) =>
      c.notNull().references('settlements.id').onDelete('cascade'),
    )
    .addColumn('language_id', 'text', (c) =>
      c.notNull().references('languages.id').onDelete('cascade'),
    )
    .addColumn('role', 'text', (c) => c.notNull())
    .addPrimaryKeyConstraint('settlement_languages_pkey', ['settlement_id', 'language_id'])
    .addCheckConstraint(
      'settlement_languages_role_check',
      sql`role in ('native', 'secondary', 'trade')`,
    )
    .execute()

  await db.schema
    .createTable('settlement_currency_attachments')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('world_id', 'text', (c) => c.notNull().references('worlds.id').onDelete('cascade'))
    .addColumn('settlement_id', 'text', (c) =>
      c.notNull().references('settlements.id').onDelete('cascade'),
    )
    .addColumn('currency_id', 'text', (c) =>
      c.notNull().references('currencies.id').onDelete('cascade'),
    )
    .addColumn('is_primary', 'boolean', (c) => c.notNull().defaultTo(false))
    .addColumn('notes', 'text', (c) => c.notNull().defaultTo(''))
    .addColumn('dm_only', 'boolean', (c) => c.notNull().defaultTo(false))
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(now))
    .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(now))
    .addColumn('deleted_at', 'timestamptz')
    .execute()

  await db.schema
    .createTable('organization_currency_attachments')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('world_id', 'text', (c) => c.notNull().references('worlds.id').onDelete('cascade'))
    .addColumn('organization_id', 'text', (c) =>
      c.notNull().references('organizations.id').onDelete('cascade'),
    )
    .addColumn('currency_id', 'text', (c) =>
      c.notNull().references('currencies.id').onDelete('cascade'),
    )
    .addColumn('is_primary', 'boolean', (c) => c.notNull().defaultTo(false))
    .addColumn('notes', 'text', (c) => c.notNull().defaultTo(''))
    .addColumn('dm_only', 'boolean', (c) => c.notNull().defaultTo(false))
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(now))
    .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(now))
    .addColumn('deleted_at', 'timestamptz')
    .execute()

  await db.schema
    .createTable('resource_locations')
    .addColumn('world_id', 'text', (c) => c.notNull().references('worlds.id').onDelete('cascade'))
    .addColumn('resource_id', 'text', (c) =>
      c.notNull().references('resources.id').onDelete('cascade'),
    )
    .addColumn('location_id', 'text', (c) =>
      c.notNull().references('locations.id').onDelete('cascade'),
    )
    .addColumn('notes', 'text', (c) => c.notNull().defaultTo(''))
    .addPrimaryKeyConstraint('resource_locations_pkey', ['resource_id', 'location_id'])
    .execute()

  // ── polymorphic ─────────────────────────────────────────────────────────
  await db.schema
    .createTable('map_pins')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('world_id', 'text', (c) => c.notNull().references('worlds.id').onDelete('cascade'))
    .addColumn('map_id', 'text', (c) => c.notNull().references('maps.id'))
    .addColumn('entity_kind', 'text', (c) => c.notNull())
    .addColumn('entity_id', 'text', (c) => c.notNull())
    .addColumn('x', sql`double precision`, (c) => c.notNull())
    .addColumn('y', sql`double precision`, (c) => c.notNull())
    .addColumn('label', 'text')
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(now))
    .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(now))
    .addColumn('deleted_at', 'timestamptz')
    .addCheckConstraint('map_pins_x_check', sql`x >= 0.0 and x <= 1.0`)
    .addCheckConstraint('map_pins_y_check', sql`y >= 0.0 and y <= 1.0`)
    .execute()

  await db.schema
    .createTable('entity_touches')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('world_id', 'text', (c) => c.notNull().references('worlds.id').onDelete('cascade'))
    .addColumn('session_id', 'text', (c) => c.notNull().references('sessions.id'))
    .addColumn('entity_kind', 'text', (c) => c.notNull())
    .addColumn('entity_id', 'text', (c) => c.notNull())
    .addColumn('touch_type', 'text', (c) => c.notNull())
    .addColumn('narrative_delta', 'text', (c) => c.notNull().defaultTo(''))
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(now))
    .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(now))
    .addColumn('deleted_at', 'timestamptz')
    .execute()

  await db.schema
    .createTable('media_attachments')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('world_id', 'text', (c) => c.notNull().references('worlds.id').onDelete('cascade'))
    .addColumn('owner_kind', 'text', (c) => c.notNull())
    .addColumn('owner_id', 'text', (c) => c.notNull())
    .addColumn('media_kind', 'text', (c) => c.notNull())
    .addColumn('file_path', 'text', (c) => c.notNull())
    .addColumn('thumbnail_path', 'text')
    .addColumn('original_filename', 'text', (c) => c.notNull())
    .addColumn('mime_type', 'text', (c) => c.notNull())
    .addColumn('byte_size', 'bigint', (c) => c.notNull())
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(now))
    .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(now))
    .addColumn('deleted_at', 'timestamptz')
    .execute()

  await db.schema
    .createTable('dm_toolkit_meta')
    .addColumn('world_id', 'text', (c) => c.notNull().references('worlds.id').onDelete('cascade'))
    .addColumn('key', 'text', (c) => c.notNull())
    .addColumn('value', 'text', (c) => c.notNull())
    .addPrimaryKeyConstraint('dm_toolkit_meta_pkey', ['world_id', 'key'])
    .execute()

  // ── net-new player surface ──────────────────────────────────────────────
  await db.schema
    .createTable('player_notes')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('world_id', 'text', (c) => c.notNull().references('worlds.id').onDelete('cascade'))
    .addColumn('author_id', 'text', (c) =>
      c.notNull().references('accounts.id').onDelete('cascade'),
    )
    .addColumn('body', 'text', (c) => c.notNull())
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(now))
    .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(now))
    .execute()

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

  await db.schema
    .createTable('suggestions')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('world_id', 'text', (c) => c.notNull().references('worlds.id').onDelete('cascade'))
    .addColumn('author_id', 'text', (c) =>
      c.notNull().references('accounts.id').onDelete('cascade'),
    )
    .addColumn('target_entity_kind', 'text')
    .addColumn('target_entity_id', 'text')
    .addColumn('proposed', 'jsonb', (c) => c.notNull())
    .addColumn('status', 'text', (c) => c.notNull().defaultTo('pending'))
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(now))
    .addCheckConstraint(
      'suggestions_status_check',
      sql`status in ('pending', 'accepted', 'rejected')`,
    )
    .execute()

  // ── indexes ─────────────────────────────────────────────────────────────
  // Per-world soft-delete entities: active-name lookup + deleted-at sweep.
  const softDeleteEntities = [
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
    'npcs',
    'pcs',
    'settlements',
  ]
  for (const table of softDeleteEntities) {
    await db.schema
      .createIndex(`${table}_active_name`)
      .on(table)
      .columns(['world_id', 'name'])
      .where(sql<SqlBool>`deleted_at is null`)
      .execute()
    await db.schema
      .createIndex(`${table}_deleted_at`)
      .on(table)
      .column('deleted_at')
      .where(sql<SqlBool>`deleted_at is not null`)
      .execute()
  }

  await db.schema
    .createIndex('calendars_unique_active')
    .unique()
    .on('calendars')
    .column('world_id')
    .where(sql<SqlBool>`is_active`)
    .execute()

  await db.schema
    .createIndex('deities_by_pantheon')
    .on('deities')
    .column('pantheon_id')
    .where(sql<SqlBool>`deleted_at is null`)
    .execute()

  await db.schema
    .createIndex('sessions_active_name')
    .on('sessions')
    .columns(['world_id', 'name'])
    .where(sql<SqlBool>`deleted_at is null`)
    .execute()
  await db.schema
    .createIndex('sessions_active_played_at')
    .on('sessions')
    .column('played_at')
    .where(sql<SqlBool>`deleted_at is null`)
    .execute()

  // junction back-reference indexes
  await db.schema
    .createIndex('culture_languages_by_language')
    .on('culture_languages')
    .column('language_id')
    .execute()
  await db.schema
    .createIndex('culture_magic_systems_by_magic_system')
    .on('culture_magic_systems')
    .column('magic_system_id')
    .execute()
  await db.schema
    .createIndex('culture_pantheons_by_pantheon')
    .on('culture_pantheons')
    .column('pantheon_id')
    .execute()
  await db.schema
    .createIndex('npc_languages_by_language')
    .on('npc_languages')
    .column('language_id')
    .execute()
  await db.schema
    .createIndex('npc_magic_systems_by_magic_system')
    .on('npc_magic_systems')
    .column('magic_system_id')
    .execute()
  await db.schema
    .createIndex('pc_languages_by_language')
    .on('pc_languages')
    .column('language_id')
    .execute()
  await db.schema
    .createIndex('pc_magic_systems_by_magic_system')
    .on('pc_magic_systems')
    .column('magic_system_id')
    .execute()
  await db.schema
    .createIndex('settlement_languages_by_language')
    .on('settlement_languages')
    .column('language_id')
    .execute()
  await db.schema
    .createIndex('resource_locations_by_location')
    .on('resource_locations')
    .column('location_id')
    .execute()

  // currency attachments
  for (const [table, owner] of [
    ['organization_currency_attachments', 'organization_id'],
    ['settlement_currency_attachments', 'settlement_id'],
  ] as const) {
    await db.schema
      .createIndex(`${table}_by_currency`)
      .on(table)
      .column('currency_id')
      .where(sql<SqlBool>`deleted_at is null`)
      .execute()
    await db.schema
      .createIndex(`${table}_by_${owner.replace('_id', '')}`)
      .on(table)
      .column(owner)
      .where(sql<SqlBool>`deleted_at is null`)
      .execute()
    await db.schema
      .createIndex(`${table}_one_primary`)
      .unique()
      .on(table)
      .column(owner)
      .where(sql<SqlBool>`is_primary and deleted_at is null`)
      .execute()
    await db.schema
      .createIndex(`${table}_unique_pair`)
      .unique()
      .on(table)
      .columns([owner, 'currency_id'])
      .where(sql<SqlBool>`deleted_at is null`)
      .execute()
  }

  await db.schema
    .createIndex('map_pins_active_by_map')
    .on('map_pins')
    .column('map_id')
    .where(sql<SqlBool>`deleted_at is null`)
    .execute()

  await db.schema
    .createIndex('entity_touches_active_by_entity')
    .on('entity_touches')
    .columns(['entity_kind', 'entity_id'])
    .where(sql<SqlBool>`deleted_at is null`)
    .execute()
  await db.schema
    .createIndex('entity_touches_active_by_session')
    .on('entity_touches')
    .column('session_id')
    .where(sql<SqlBool>`deleted_at is null`)
    .execute()

  await db.schema
    .createIndex('media_attachments_by_owner')
    .on('media_attachments')
    .columns(['owner_kind', 'owner_id'])
    .where(sql<SqlBool>`deleted_at is null`)
    .execute()
  await db.schema
    .createIndex('media_attachments_deleted_at')
    .on('media_attachments')
    .column('deleted_at')
    .where(sql<SqlBool>`deleted_at is not null`)
    .execute()
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // reverse dependency order
  const tables = [
    'suggestions',
    'player_characters',
    'player_notes',
    'dm_toolkit_meta',
    'media_attachments',
    'entity_touches',
    'map_pins',
    'resource_locations',
    'organization_currency_attachments',
    'settlement_currency_attachments',
    'settlement_languages',
    'pc_magic_systems',
    'pc_languages',
    'npc_magic_systems',
    'npc_languages',
    'culture_pantheons',
    'culture_magic_systems',
    'culture_languages',
    'settlements',
    'pcs',
    'npcs',
    'sessions',
    'calendars',
    'maps',
    'lore_articles',
    'events',
    'items',
    'organizations',
    'locations',
    'resources',
    'deities',
    'currencies',
    'magic_systems',
    'languages',
    'pantheons',
    'cultures',
    'species',
    'world_members',
    'worlds',
    'auth_sessions',
    'accounts',
  ]
  for (const table of tables) {
    await db.schema.dropTable(table).ifExists().execute()
  }
}
