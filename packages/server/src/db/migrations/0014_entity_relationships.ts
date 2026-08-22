import { type Kysely, sql } from 'kysely'

/**
 * Typed relationships between entities: HOW two entities relate, as opposed to
 * the fact that one's prose mentions the other.
 *
 * ONE table, not sixteen more junctions. The kind-specific junctions that came
 * from the legacy import (`npc_languages`, `culture_pantheons`, …) are the
 * pattern migration 0005 moved away from when it folded sixteen per-kind tables
 * into `entities`; adding eleven relationship types across sixteen kinds in that
 * style would be a combinatorial explosion of tables that all say the same thing.
 *
 * ONE row per relationship, directional. The inverse is rendered from the same
 * row on the other entity's page (see `shared/relationships.ts`). Storing two
 * rows would leave every later operation able to update one and miss the other,
 * producing a relationship that shows on one page and not the other.
 *
 * `type` is deliberately NOT constrained by a CHECK. The vocabulary lives in
 * `packages/shared` where the server, the SPA and the graph all read it, and the
 * route validates against that list — the same choice migration 0005 made when
 * it dropped the per-kind CHECKs in favour of an enum in shared. A CHECK here
 * would be a second copy of the vocabulary, and adding a twelfth type would then
 * mean a migration rather than a one-line change.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('entity_relationships')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('world_id', 'text', (c) => c.notNull().references('worlds.id').onDelete('cascade'))
    // Both endpoints cascade: a relationship whose subject is gone is not a
    // relationship, and leaving the row would strand a reference to a deleted id
    // that every read would then have to filter out.
    .addColumn('from_id', 'text', (c) => c.notNull().references('entities.id').onDelete('cascade'))
    .addColumn('to_id', 'text', (c) => c.notNull().references('entities.id').onDelete('cascade'))
    .addColumn('type', 'text', (c) => c.notNull())
    .addColumn('note', 'text', (c) => c.notNull().defaultTo(''))
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    // An entity related to ITSELF is always a mistake, and one that renders as a
    // nonsense line on its own page. Cheaper to refuse than to filter forever.
    .addCheckConstraint('entity_relationships_not_self', sql`from_id <> to_id`)
    .execute()

  // The same pair may hold several DIFFERENT relations (an NPC can lead an
  // organization and be a member of it), but not the same one twice — a
  // duplicate is always a double-click, never an intent.
  await db.schema
    .createIndex('entity_relationships_unique')
    .on('entity_relationships')
    .columns(['world_id', 'from_id', 'to_id', 'type'])
    .unique()
    .execute()

  // An entity's page reads relationships in BOTH directions, so both endpoints
  // are indexed; a single composite on (world_id, from_id) would leave the
  // inverse lookup scanning the world.
  await db.schema
    .createIndex('entity_relationships_by_from')
    .on('entity_relationships')
    .columns(['world_id', 'from_id'])
    .execute()
  await db.schema
    .createIndex('entity_relationships_by_to')
    .on('entity_relationships')
    .columns(['world_id', 'to_id'])
    .execute()
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('entity_relationships').execute()
}
