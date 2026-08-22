import { type Kysely, type SqlBool, sql } from 'kysely'

/**
 * Class-table inheritance for the 16 content "kinds". Before this migration each
 * kind (npc, pc, settlement, …) lived in its OWN table, all repeating the shared
 * columns (id/world_id/name/description/visibility/imported_metadata/timestamps/
 * deleted_at) plus a few kind-specific columns. This collapses the shared columns
 * into ONE base table `entities` (carrying a `kind` discriminator) and moves each
 * kind's extra columns into a slim `<kind>_details` table keyed 1:1 by
 * `entity_id`. Kinds with no extra columns (location, organization, item) get no
 * detail table.
 *
 * Consequences baked in here (see the plan):
 *  - Every cross-entity reference (junction FKs + the intra-entity FKs like
 *    npcs.species_id) now points at `entities.id` uniformly — some referenced
 *    kinds (e.g. location) have no detail table, so the base id is the only
 *    common target. We lose the DB-level "must be exactly kind X" guarantee
 *    (it was FK-to-table; it is now app-enforced — the importer is the writer).
 *  - The polymorphic reference tables drop their redundant kind discriminator and
 *    key off the id alone (ids are globally-unique UUIDs), gaining a real FK to
 *    `entities.id`. This structurally removes the change-kind leak (no stale kind
 *    to repoint). EXCEPTION: `media_attachments` keeps `owner_kind` and gets no
 *    FK — media owners span entities ∪ sessions, and one FK can't target two
 *    tables. sessions/maps stay their own tables (bespoke; not among the 16).
 *  - `lore_articles.kind` (the article sub-type) is renamed to
 *    `lore_article_details.article_kind` so it can't collide with the new
 *    `entities.kind` discriminator in the flat merged read shape.
 *
 * Detail tables carry `world_id` (denormalized) so the generic, world-scoped
 * export/import loop (world-io) treats them like every other content table.
 */

const now = sql`now()`

// The 16 content kinds (singular registry kind) — the `entities.kind` domain.
const CONTENT_KINDS = [
  'npc',
  'pc',
  'settlement',
  'item',
  'organization',
  'location',
  'event',
  'lore_article',
  'currency',
  'language',
  'species',
  'culture',
  'magic_system',
  'resource',
  'pantheon',
  'deity',
] as const

// Old per-kind table (plural) → its kind discriminator. Drives the entities
// backfill and, reversed, the down() reconstruction.
const TABLE_KIND: ReadonlyArray<readonly [string, string]> = [
  ['species', 'species'],
  ['cultures', 'culture'],
  ['pantheons', 'pantheon'],
  ['languages', 'language'],
  ['magic_systems', 'magic_system'],
  ['currencies', 'currency'],
  ['resources', 'resource'],
  ['locations', 'location'],
  ['organizations', 'organization'],
  ['items', 'item'],
  ['events', 'event'],
  ['lore_articles', 'lore_article'],
  ['deities', 'deity'],
  ['npcs', 'npc'],
  ['pcs', 'pc'],
  ['settlements', 'settlement'],
]

// Junction / attachment entity-reference columns and the per-kind table each one
// referenced before this migration (all ON DELETE CASCADE). up() re-points every
// one to entities.id; down() restores them to the per-kind table.
const CROSS_REFS: ReadonlyArray<{ table: string; col: string; ref: string }> = [
  { table: 'culture_languages', col: 'culture_id', ref: 'cultures' },
  { table: 'culture_languages', col: 'language_id', ref: 'languages' },
  { table: 'culture_magic_systems', col: 'culture_id', ref: 'cultures' },
  { table: 'culture_magic_systems', col: 'magic_system_id', ref: 'magic_systems' },
  { table: 'culture_pantheons', col: 'culture_id', ref: 'cultures' },
  { table: 'culture_pantheons', col: 'pantheon_id', ref: 'pantheons' },
  { table: 'npc_languages', col: 'npc_id', ref: 'npcs' },
  { table: 'npc_languages', col: 'language_id', ref: 'languages' },
  { table: 'npc_magic_systems', col: 'npc_id', ref: 'npcs' },
  { table: 'npc_magic_systems', col: 'magic_system_id', ref: 'magic_systems' },
  { table: 'pc_languages', col: 'pc_id', ref: 'pcs' },
  { table: 'pc_languages', col: 'language_id', ref: 'languages' },
  { table: 'pc_magic_systems', col: 'pc_id', ref: 'pcs' },
  { table: 'pc_magic_systems', col: 'magic_system_id', ref: 'magic_systems' },
  { table: 'settlement_languages', col: 'settlement_id', ref: 'settlements' },
  { table: 'settlement_languages', col: 'language_id', ref: 'languages' },
  { table: 'resource_locations', col: 'resource_id', ref: 'resources' },
  { table: 'resource_locations', col: 'location_id', ref: 'locations' },
  { table: 'settlement_currency_attachments', col: 'settlement_id', ref: 'settlements' },
  { table: 'settlement_currency_attachments', col: 'currency_id', ref: 'currencies' },
  { table: 'organization_currency_attachments', col: 'organization_id', ref: 'organizations' },
  { table: 'organization_currency_attachments', col: 'currency_id', ref: 'currencies' },
]

// Drop-order for the old per-kind tables: referencing tables before referenced
// (npcs→species/cultures, pcs→species, settlements→cultures, deities→pantheons).
const OLD_ENTITY_TABLES_DROP_ORDER = [
  'npcs',
  'pcs',
  'settlements',
  'deities',
  'species',
  'cultures',
  'pantheons',
  'currencies',
  'languages',
  'magic_systems',
  'resources',
  'locations',
  'organizations',
  'items',
  'events',
  'lore_articles',
] as const

const fkName = (table: string, col: string): string => `${table}_${col}_fkey`

async function repointFk(
  db: Kysely<unknown>,
  table: string,
  col: string,
  ref: string,
): Promise<void> {
  await sql`alter table ${sql.ref(table)} drop constraint ${sql.ref(fkName(table, col))}`.execute(
    db,
  )
  await sql`alter table ${sql.ref(table)} add constraint ${sql.ref(fkName(table, col))}
    foreign key (${sql.ref(col)}) references ${sql.ref(ref)} (id) on delete cascade`.execute(db)
}

export async function up(db: Kysely<unknown>): Promise<void> {
  // 1. base table ----------------------------------------------------------
  await db.schema
    .createTable('entities')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('world_id', 'text', (c) => c.notNull().references('worlds.id').onDelete('cascade'))
    .addColumn('kind', 'text', (c) => c.notNull())
    .addColumn('name', 'text', (c) => c.notNull())
    .addColumn('description', 'text', (c) => c.notNull().defaultTo(''))
    .addColumn('visibility', 'text', (c) => c.notNull().defaultTo('public'))
    .addColumn('imported_metadata', 'jsonb')
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(now))
    .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(now))
    .addColumn('deleted_at', 'timestamptz')
    .addCheckConstraint(
      'entities_visibility_check',
      sql`visibility in ('public', 'dm_only', 'restricted')`,
    )
    .addCheckConstraint(
      'entities_kind_check',
      sql`kind in (${sql.join(CONTENT_KINDS.map((k) => sql.lit(k)))})`,
    )
    .execute()

  await db.schema
    .createIndex('entities_world_kind_idx')
    .on('entities')
    .columns(['world_id', 'kind'])
    .execute()
  await db.schema
    .createIndex('entities_active_name')
    .on('entities')
    .columns(['world_id', 'name'])
    .where(sql<SqlBool>`deleted_at is null`)
    .execute()
  await db.schema
    .createIndex('entities_deleted_at')
    .on('entities')
    .column('deleted_at')
    .where(sql<SqlBool>`deleted_at is not null`)
    .execute()

  // 2. detail tables (entity_id 1:1 → entities; world_id denormalized for the
  //    generic export loop). Cross-entity FKs target entities.id. -----------
  const detail = (name: string) =>
    db.schema
      .createTable(name)
      .addColumn('entity_id', 'text', (c) =>
        c.primaryKey().references('entities.id').onDelete('cascade'),
      )
      .addColumn('world_id', 'text', (c) => c.notNull().references('worlds.id').onDelete('cascade'))

  await detail('species_details')
    .addColumn('kingdom', 'text', (c) => c.notNull().defaultTo(''))
    .addColumn('elemental_alignment', 'text')
    .addColumn('is_corporeal', 'boolean', (c) => c.notNull().defaultTo(true))
    .addColumn('is_sentient', 'boolean', (c) => c.notNull().defaultTo(true))
    .execute()

  await detail('culture_details')
    .addColumn('dominant_values', 'text', (c) => c.notNull().defaultTo(''))
    .addColumn('historical_period', 'text', (c) => c.notNull().defaultTo(''))
    .addColumn('aesthetic_notes', 'text', (c) => c.notNull().defaultTo(''))
    .execute()

  await detail('pantheon_details')
    .addColumn('tradition', 'text', (c) => c.notNull().defaultTo(''))
    .addColumn('historical_period', 'text', (c) => c.notNull().defaultTo(''))
    .execute()

  await detail('language_details')
    .addColumn('family', 'text', (c) => c.notNull().defaultTo(''))
    .addColumn('is_trade_language', 'boolean', (c) => c.notNull().defaultTo(false))
    .addColumn('writing_system', 'text', (c) => c.notNull().defaultTo(''))
    .execute()

  await detail('magic_system_details')
    .addColumn('source_kind', 'text', (c) => c.notNull().defaultTo(''))
    .addColumn('cost_summary', 'text', (c) => c.notNull().defaultTo(''))
    .addColumn('alignment', 'text', (c) => c.notNull().defaultTo(''))
    .addColumn('is_taught', 'boolean', (c) => c.notNull().defaultTo(false))
    .addColumn('requires_materials', 'boolean', (c) => c.notNull().defaultTo(false))
    .execute()

  await detail('currency_details')
    .addColumn('symbol', 'text', (c) => c.notNull().defaultTo(''))
    .addColumn('denominations', 'jsonb', (c) => c.notNull().defaultTo(sql`'[]'::jsonb`))
    .addColumn('base_rate_to', 'text', (c) => c.references('entities.id'))
    .addColumn('rate', sql`double precision`)
    .execute()

  await detail('deity_details')
    .addColumn('domain', 'text', (c) => c.notNull().defaultTo(''))
    .addColumn('worship_status', 'text', (c) => c.notNull().defaultTo(''))
    .addColumn('pantheon_id', 'text', (c) => c.references('entities.id').onDelete('set null'))
    .execute()

  await detail('resource_details')
    .addColumn('resource_kind', 'text', (c) => c.notNull().defaultTo(''))
    .addColumn('scarcity', 'text', (c) => c.notNull().defaultTo(''))
    .addColumn('commercial_value', 'text', (c) => c.notNull().defaultTo(''))
    .execute()

  await detail('event_details').addColumn('occurred_at', 'text').execute()

  await detail('lore_article_details').addColumn('article_kind', 'text').execute()

  await detail('npc_details')
    .addColumn('species_id', 'text', (c) => c.references('entities.id'))
    .addColumn('culture_id', 'text', (c) => c.references('entities.id'))
    .addColumn('occupation', 'text', (c) => c.notNull().defaultTo(''))
    .execute()

  await detail('pc_details')
    .addColumn('species_id', 'text', (c) => c.references('entities.id'))
    .execute()

  await detail('settlement_details')
    .addColumn('culture_id', 'text', (c) => c.references('entities.id'))
    .addColumn('size', 'text', (c) => c.notNull().defaultTo(''))
    .addColumn('wealth', 'text', (c) => c.notNull().defaultTo(''))
    .addColumn('terrain', 'text', (c) => c.notNull().defaultTo(''))
    .addColumn('population', 'integer', (c) => c.notNull().defaultTo(0))
    .execute()

  // 3. backfill entities from every per-kind table (ALL before any detail) ---
  for (const [table, kind] of TABLE_KIND) {
    await sql`
      insert into entities
        (id, world_id, kind, name, description, visibility, imported_metadata,
         created_at, updated_at, deleted_at)
      select id, world_id, ${sql.lit(kind)}, name, description, visibility, imported_metadata,
             created_at, updated_at, deleted_at
      from ${sql.ref(table)}
    `.execute(db)
  }

  // 4. backfill detail tables (entities now holds every referenced id) -------
  const copyDetail = (name: string, from: string, cols: string): Promise<unknown> =>
    sql`insert into ${sql.ref(name)} (entity_id, world_id, ${sql.raw(cols)})
        select id, world_id, ${sql.raw(cols)} from ${sql.ref(from)}`.execute(db)

  await copyDetail(
    'species_details',
    'species',
    'kingdom, elemental_alignment, is_corporeal, is_sentient',
  )
  await copyDetail(
    'culture_details',
    'cultures',
    'dominant_values, historical_period, aesthetic_notes',
  )
  await copyDetail('pantheon_details', 'pantheons', 'tradition, historical_period')
  await copyDetail('language_details', 'languages', 'family, is_trade_language, writing_system')
  await copyDetail(
    'magic_system_details',
    'magic_systems',
    'source_kind, cost_summary, alignment, is_taught, requires_materials',
  )
  await copyDetail('currency_details', 'currencies', 'symbol, denominations, base_rate_to, rate')
  await copyDetail('deity_details', 'deities', 'domain, worship_status, pantheon_id')
  await copyDetail('resource_details', 'resources', 'resource_kind, scarcity, commercial_value')
  await copyDetail('event_details', 'events', 'occurred_at')
  await sql`insert into lore_article_details (entity_id, world_id, article_kind)
            select id, world_id, kind from lore_articles`.execute(db)
  await copyDetail('npc_details', 'npcs', 'species_id, culture_id, occupation')
  await copyDetail('pc_details', 'pcs', 'species_id')
  await copyDetail(
    'settlement_details',
    'settlements',
    'culture_id, size, wealth, terrain, population',
  )

  // 5. re-point junction/attachment + polymorphic references to entities.id --
  for (const { table, col } of CROSS_REFS) await repointFk(db, table, col, 'entities')

  // entity_visibility: (world_id, entity_kind, entity_id, account_id) → keyed on entity_id.
  await sql`alter table entity_visibility drop constraint entity_visibility_pk`.execute(db)
  await db.schema.alterTable('entity_visibility').dropColumn('entity_kind').execute()
  await db.schema
    .alterTable('entity_visibility')
    .addPrimaryKeyConstraint('entity_visibility_pk', ['world_id', 'entity_id', 'account_id'])
    .execute()
  await sql`alter table entity_visibility add constraint entity_visibility_entity_id_fkey
    foreign key (entity_id) references entities (id) on delete cascade`.execute(db)

  // entity_touches: drop the (entity_kind, entity_id) index + column, re-index on entity_id.
  await db.schema.dropIndex('entity_touches_active_by_entity').execute()
  await db.schema.alterTable('entity_touches').dropColumn('entity_kind').execute()
  await sql`alter table entity_touches add constraint entity_touches_entity_id_fkey
    foreign key (entity_id) references entities (id) on delete cascade`.execute(db)
  await db.schema
    .createIndex('entity_touches_active_by_entity')
    .on('entity_touches')
    .column('entity_id')
    .where(sql<SqlBool>`deleted_at is null`)
    .execute()

  // map_pins
  await db.schema.alterTable('map_pins').dropColumn('entity_kind').execute()
  await sql`alter table map_pins add constraint map_pins_entity_id_fkey
    foreign key (entity_id) references entities (id) on delete cascade`.execute(db)

  // suggestions (target_entity_id is nullable → SET NULL)
  await db.schema.alterTable('suggestions').dropColumn('target_entity_kind').execute()
  await sql`alter table suggestions add constraint suggestions_target_entity_id_fkey
    foreign key (target_entity_id) references entities (id) on delete set null`.execute(db)

  // 6. drop the old per-kind tables (indexes/self-FKs go with them) ---------
  for (const table of OLD_ENTITY_TABLES_DROP_ORDER) {
    await db.schema.dropTable(table).execute()
  }
}

// ── down(): reconstruct the post-0004 topology (per-kind tables with
//    `visibility`, NOT `dm_only`) so 0004.down / 0001.down can run. ─────────

const VISIBILITY_CHECK = sql`visibility in ('public', 'dm_only', 'restricted')`

export async function down(db: Kysely<unknown>): Promise<void> {
  // 1. recreate the 16 per-kind tables in dependency order (targets first) ---
  const base = (name: string) =>
    db.schema
      .createTable(name)
      .addColumn('id', 'text', (c) => c.primaryKey())
      .addColumn('world_id', 'text', (c) => c.notNull().references('worlds.id').onDelete('cascade'))
      .addColumn('name', 'text', (c) => c.notNull())
      .addColumn('description', 'text', (c) => c.notNull().defaultTo(''))
      .addColumn('visibility', 'text', (c) => c.notNull().defaultTo('public'))
      .addColumn('imported_metadata', 'jsonb')
      .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(now))
      .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(now))
      .addColumn('deleted_at', 'timestamptz')

  await base('species')
    .addColumn('kingdom', 'text', (c) => c.notNull().defaultTo(''))
    .addColumn('elemental_alignment', 'text')
    .addColumn('is_corporeal', 'boolean', (c) => c.notNull().defaultTo(true))
    .addColumn('is_sentient', 'boolean', (c) => c.notNull().defaultTo(true))
    .execute()
  await base('cultures')
    .addColumn('dominant_values', 'text', (c) => c.notNull().defaultTo(''))
    .addColumn('historical_period', 'text', (c) => c.notNull().defaultTo(''))
    .addColumn('aesthetic_notes', 'text', (c) => c.notNull().defaultTo(''))
    .execute()
  await base('pantheons')
    .addColumn('tradition', 'text', (c) => c.notNull().defaultTo(''))
    .addColumn('historical_period', 'text', (c) => c.notNull().defaultTo(''))
    .execute()
  await base('currencies')
    .addColumn('symbol', 'text', (c) => c.notNull().defaultTo(''))
    .addColumn('denominations', 'jsonb', (c) => c.notNull().defaultTo(sql`'[]'::jsonb`))
    .addColumn('base_rate_to', 'text', (c) => c.references('currencies.id'))
    .addColumn('rate', sql`double precision`)
    .execute()
  await base('languages')
    .addColumn('family', 'text', (c) => c.notNull().defaultTo(''))
    .addColumn('is_trade_language', 'boolean', (c) => c.notNull().defaultTo(false))
    .addColumn('writing_system', 'text', (c) => c.notNull().defaultTo(''))
    .execute()
  await base('magic_systems')
    .addColumn('source_kind', 'text', (c) => c.notNull().defaultTo(''))
    .addColumn('cost_summary', 'text', (c) => c.notNull().defaultTo(''))
    .addColumn('alignment', 'text', (c) => c.notNull().defaultTo(''))
    .addColumn('is_taught', 'boolean', (c) => c.notNull().defaultTo(false))
    .addColumn('requires_materials', 'boolean', (c) => c.notNull().defaultTo(false))
    .execute()
  await base('resources')
    .addColumn('resource_kind', 'text', (c) => c.notNull().defaultTo(''))
    .addColumn('scarcity', 'text', (c) => c.notNull().defaultTo(''))
    .addColumn('commercial_value', 'text', (c) => c.notNull().defaultTo(''))
    .execute()
  await base('locations').execute()
  await base('organizations').execute()
  await base('items').execute()
  await base('events').addColumn('occurred_at', 'text').execute()
  await base('lore_articles').addColumn('kind', 'text').execute()
  await base('deities')
    .addColumn('domain', 'text', (c) => c.notNull().defaultTo(''))
    .addColumn('worship_status', 'text', (c) => c.notNull().defaultTo(''))
    .addColumn('pantheon_id', 'text', (c) => c.references('pantheons.id').onDelete('set null'))
    .execute()
  await base('npcs')
    .addColumn('species_id', 'text', (c) => c.references('species.id'))
    .addColumn('culture_id', 'text', (c) => c.references('cultures.id'))
    .addColumn('occupation', 'text', (c) => c.notNull().defaultTo(''))
    .execute()
  await base('pcs')
    .addColumn('species_id', 'text', (c) => c.references('species.id'))
    .execute()
  await base('settlements')
    .addColumn('culture_id', 'text', (c) => c.references('cultures.id'))
    .addColumn('size', 'text', (c) => c.notNull().defaultTo(''))
    .addColumn('wealth', 'text', (c) => c.notNull().defaultTo(''))
    .addColumn('terrain', 'text', (c) => c.notNull().defaultTo(''))
    .addColumn('population', 'integer', (c) => c.notNull().defaultTo(0))
    .execute()

  // visibility CHECK on every recreated table
  for (const [table] of TABLE_KIND) {
    await sql`alter table ${sql.ref(table)} add constraint ${sql.ref(
      `${table}_visibility_check`,
    )} check (${VISIBILITY_CHECK})`.execute(db)
  }

  // 2. backfill per-kind tables from entities(+detail) — dependency order ----
  const restore = (table: string, kind: string, from: string, cols: string): Promise<unknown> =>
    sql`insert into ${sql.ref(table)}
          (id, world_id, name, description, visibility, imported_metadata,
           created_at, updated_at, deleted_at, ${sql.raw(cols)})
        select e.id, e.world_id, e.name, e.description, e.visibility, e.imported_metadata,
               e.created_at, e.updated_at, e.deleted_at, ${sql.raw(
                 cols
                   .split(', ')
                   .map((c) => `d.${c}`)
                   .join(', '),
               )}
        from entities e join ${sql.ref(from)} d on d.entity_id = e.id
        where e.kind = ${sql.lit(kind)}`.execute(db)

  const restorePlain = (table: string, kind: string): Promise<unknown> =>
    sql`insert into ${sql.ref(table)}
          (id, world_id, name, description, visibility, imported_metadata,
           created_at, updated_at, deleted_at)
        select id, world_id, name, description, visibility, imported_metadata,
               created_at, updated_at, deleted_at
        from entities where kind = ${sql.lit(kind)}`.execute(db)

  await restore(
    'species',
    'species',
    'species_details',
    'kingdom, elemental_alignment, is_corporeal, is_sentient',
  )
  await restore(
    'cultures',
    'culture',
    'culture_details',
    'dominant_values, historical_period, aesthetic_notes',
  )
  await restore('pantheons', 'pantheon', 'pantheon_details', 'tradition, historical_period')
  await restore(
    'currencies',
    'currency',
    'currency_details',
    'symbol, denominations, base_rate_to, rate',
  )
  await restore(
    'languages',
    'language',
    'language_details',
    'family, is_trade_language, writing_system',
  )
  await restore(
    'magic_systems',
    'magic_system',
    'magic_system_details',
    'source_kind, cost_summary, alignment, is_taught, requires_materials',
  )
  await restore(
    'resources',
    'resource',
    'resource_details',
    'resource_kind, scarcity, commercial_value',
  )
  await restorePlain('locations', 'location')
  await restorePlain('organizations', 'organization')
  await restorePlain('items', 'item')
  await restore('events', 'event', 'event_details', 'occurred_at')
  await sql`insert into lore_articles
        (id, world_id, name, description, visibility, imported_metadata,
         created_at, updated_at, deleted_at, kind)
      select e.id, e.world_id, e.name, e.description, e.visibility, e.imported_metadata,
             e.created_at, e.updated_at, e.deleted_at, d.article_kind
      from entities e join lore_article_details d on d.entity_id = e.id
      where e.kind = 'lore_article'`.execute(db)
  await restore('deities', 'deity', 'deity_details', 'domain, worship_status, pantheon_id')
  await restore('npcs', 'npc', 'npc_details', 'species_id, culture_id, occupation')
  await restore('pcs', 'pc', 'pc_details', 'species_id')
  await restore(
    'settlements',
    'settlement',
    'settlement_details',
    'culture_id, size, wealth, terrain, population',
  )

  // 3. re-point junction/attachment FKs back to the per-kind tables ---------
  for (const { table, col, ref } of CROSS_REFS) await repointFk(db, table, col, ref)

  // 4. restore the polymorphic kind discriminators (entities still present) --
  await sql`alter table entity_visibility drop constraint entity_visibility_pk`.execute(db)
  await sql`alter table entity_visibility drop constraint entity_visibility_entity_id_fkey`.execute(
    db,
  )
  await db.schema.alterTable('entity_visibility').addColumn('entity_kind', 'text').execute()
  await sql`update entity_visibility ev set entity_kind = e.kind from entities e where e.id = ev.entity_id`.execute(
    db,
  )
  await db.schema
    .alterTable('entity_visibility')
    .alterColumn('entity_kind', (c) => c.setNotNull())
    .execute()
  await db.schema
    .alterTable('entity_visibility')
    .addPrimaryKeyConstraint('entity_visibility_pk', [
      'world_id',
      'entity_kind',
      'entity_id',
      'account_id',
    ])
    .execute()

  await sql`alter table entity_touches drop constraint entity_touches_entity_id_fkey`.execute(db)
  await db.schema.dropIndex('entity_touches_active_by_entity').execute()
  await db.schema.alterTable('entity_touches').addColumn('entity_kind', 'text').execute()
  await sql`update entity_touches et set entity_kind = e.kind from entities e where e.id = et.entity_id`.execute(
    db,
  )
  await db.schema
    .alterTable('entity_touches')
    .alterColumn('entity_kind', (c) => c.setNotNull())
    .execute()
  await db.schema
    .createIndex('entity_touches_active_by_entity')
    .on('entity_touches')
    .columns(['entity_kind', 'entity_id'])
    .where(sql<SqlBool>`deleted_at is null`)
    .execute()

  await sql`alter table map_pins drop constraint map_pins_entity_id_fkey`.execute(db)
  await db.schema.alterTable('map_pins').addColumn('entity_kind', 'text').execute()
  await sql`update map_pins mp set entity_kind = e.kind from entities e where e.id = mp.entity_id`.execute(
    db,
  )
  await db.schema
    .alterTable('map_pins')
    .alterColumn('entity_kind', (c) => c.setNotNull())
    .execute()

  await sql`alter table suggestions drop constraint suggestions_target_entity_id_fkey`.execute(db)
  await db.schema.alterTable('suggestions').addColumn('target_entity_kind', 'text').execute()
  await sql`update suggestions s set target_entity_kind = e.kind
            from entities e where e.id = s.target_entity_id`.execute(db)

  // 5. per-kind indexes (fidelity with 0001) --------------------------------
  for (const [table] of TABLE_KIND) {
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
    .createIndex('deities_by_pantheon')
    .on('deities')
    .column('pantheon_id')
    .where(sql<SqlBool>`deleted_at is null`)
    .execute()

  // 6. drop the detail tables + base --------------------------------------
  for (const t of [
    'species_details',
    'culture_details',
    'pantheon_details',
    'language_details',
    'magic_system_details',
    'currency_details',
    'deity_details',
    'resource_details',
    'event_details',
    'lore_article_details',
    'npc_details',
    'pc_details',
    'settlement_details',
  ]) {
    await db.schema.dropTable(t).execute()
  }
  await db.schema.dropTable('entities').execute()
}
