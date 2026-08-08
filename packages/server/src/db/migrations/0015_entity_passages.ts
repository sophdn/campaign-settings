import { type Kysely, sql } from 'kysely'

/**
 * Passages: prose belonging to an entity, revealed in stages.
 *
 * An entity's `visibility` is all-or-nothing — the party has either met the
 * NPC or they have not. But a DM's NPC write-up is rarely one secret; it is a
 * public face plus several reveals that land in different sessions, sometimes
 * for different players. Today the only way to run that is to keep the real
 * text outside the app and paste in fragments by hand.
 *
 * A passage is one such fragment, with its own visibility. What a viewer reads
 * is the entity's base `description` followed by the passages they may see.
 *
 * ## `entities.description` STAYS. Passages are additive.
 *
 * The tempting shape is to make `description` derived — passage 0 is the public
 * layer, everything composes. Rejected: `description` is read by world export
 * and import, the legacy importer, the suggestion flow, the bracket picker and
 * the entity editor, and making it derived breaks all of them at once for no
 * user-visible gain. The storage is identical either way; this choice only
 * decides how much gets rewritten today. Demoting `description` to a passage
 * later remains available and is a data migration, not a redesign.
 *
 * ## The shape is chosen so the authorization seam covers it for free
 *
 * `ContentTableName` in authz/content.ts is DERIVED, not enumerated: any table
 * carrying `id`, `world_id`, `visibility` and `deleted_at` is a content table.
 * So giving `entity_passages` those four columns means world-scoping,
 * soft-delete hiding, the 3-state visibility filter and owner-only writes all
 * apply with no authorization code written here. That is deliberate — it is the
 * same reason 0005 folded sixteen tables into `entities` rather than teaching
 * sixteen code paths the same rule.
 *
 * ## `visibility` defaults to dm_only, not public
 *
 * Every other content table defaults to `public`, because an entity is normally
 * something the party can see. A passage is the opposite by construction: it
 * exists because the DM had something to withhold. A passage created without an
 * explicit visibility must never be readable by a player, so the default fails
 * closed and the DM opens it deliberately.
 *
 * ## `passage_visibility` gets the foreign keys `entity_visibility` never got
 *
 * The sibling ACL grew its constraints late: 0004 created all four columns
 * plain, 0005 added the entity FK, 0012 added the account FK reasoning that "a
 * grant is meaningless without the account it names", and `world_id` still has
 * none. This table takes all three from the start. The divergence is
 * intentional — it is the shape `entity_visibility` would have if it were
 * written today, not an inconsistency to reconcile.
 *
 * ## `author_id` is nullable, on purpose
 *
 * Two callers need it to be. Account deletion must not be blocked by, nor
 * cascade away, a passage the DM has woven into their world — so the FK is SET
 * NULL and authorship is forgotten while the prose survives. And a world export
 * carries DM content across servers where account ids do not resolve; a
 * nullable column can be carried empty rather than forcing the export to omit
 * the table (see world-io/tables.ts, which excludes the account-coupled tables
 * for exactly this reason and now excludes `passage_visibility` too).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('entity_passages')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('world_id', 'text', (c) => c.notNull().references('worlds.id').onDelete('cascade'))
    // A passage without its entity is not a passage. Cascade, like every other
    // row that hangs off an entity (0005's details, 0014's relationships).
    .addColumn('entity_id', 'text', (c) =>
      c.notNull().references('entities.id').onDelete('cascade'),
    )
    // SET NULL, not CASCADE: deleting the account that wrote a reveal must not
    // delete the reveal. The DM's world keeps the prose; it just stops knowing
    // who typed it.
    .addColumn('author_id', 'text', (c) => c.references('accounts.id').onDelete('set null'))
    .addColumn('body', 'text', (c) => c.notNull().defaultTo(''))
    .addColumn('position', 'integer', (c) => c.notNull().defaultTo(0))
    // 'proposed' is a player's suggested addition awaiting the owner's review;
    // 'published' is part of the world. A proposal is additionally restricted to
    // its author by a single passage_visibility row, so it needs no exception in
    // the seam — see data/passages.ts.
    .addColumn('status', 'text', (c) => c.notNull().defaultTo('published'))
    .addColumn('visibility', 'text', (c) => c.notNull().defaultTo('dm_only'))
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn('deleted_at', 'timestamptz')
    .addCheckConstraint('entity_passages_status_check', sql`status in ('published', 'proposed')`)
    .addCheckConstraint(
      'entity_passages_visibility_check',
      sql`visibility in ('public', 'dm_only', 'restricted')`,
    )
    .execute()

  // The only read shape that matters: every live passage for a set of entities,
  // in render order. Composing one entity's page and composing a list of fifty
  // both go through this.
  await db.schema
    .createIndex('entity_passages_by_entity')
    .on('entity_passages')
    .columns(['world_id', 'entity_id', 'position'])
    .execute()

  await db.schema
    .createTable('passage_visibility')
    .addColumn('world_id', 'text', (c) => c.notNull().references('worlds.id').onDelete('cascade'))
    .addColumn('passage_id', 'text', (c) =>
      c.notNull().references('entity_passages.id').onDelete('cascade'),
    )
    .addColumn('account_id', 'text', (c) =>
      c.notNull().references('accounts.id').onDelete('cascade'),
    )
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addPrimaryKeyConstraint('passage_visibility_pk', ['world_id', 'passage_id', 'account_id'])
    .execute()

  // Mirrors entity_visibility_account_idx: the seam looks grants up by
  // (world, account) while filtering a list of passages.
  await db.schema
    .createIndex('passage_visibility_account_idx')
    .on('passage_visibility')
    .columns(['world_id', 'account_id'])
    .execute()
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('passage_visibility').execute()
  await db.schema.dropTable('entity_passages').execute()
}
