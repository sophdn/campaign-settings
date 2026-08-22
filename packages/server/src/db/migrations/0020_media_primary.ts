import { type Kysely, sql } from 'kysely'

/**
 * THE image for an entity.
 *
 * `media_attachments` held a flat list: an entity had images, and the page
 * rendered every one of them as a thumbnail near the bottom. So art attached to
 * a character had no prominence at all — you scrolled past the editor and every
 * other panel to find a portrait. There was no way to say which one was the
 * portrait, because the schema had nowhere to record it.
 *
 * The column follows the existing idiom exactly: `is_primary boolean not null
 * default false`, the same shape `settlement_currency_attachments` and
 * `organization_currency_attachments` have carried since 0001 for the same kind
 * of question ("which of these several is THE one").
 *
 * ## Why a partial unique index and not a write-path check
 *
 * At most one primary per owner has to hold against every caller, including the
 * legacy importer and any future one that never passes through the route. A
 * partial unique index over `(world_id, owner_kind, owner_id) WHERE is_primary`
 * says it once, in the place that cannot be bypassed. Postgres cannot express
 * this as a table CHECK — that would need a subquery — and this codebase uses
 * no triggers.
 *
 * The write path still clears the previous primary before setting the new one,
 * inside a transaction. That is not a second enforcement: it is what makes
 * "make this one primary" mean what a user expects, rather than refusing
 * because another row already holds the seat. The index is the guarantee; the
 * transaction is the behaviour.
 *
 * Nothing to backfill. Every existing attachment stays non-primary, which is
 * the correct reading of a world whose owner has never been asked the question:
 * the page shows a neutral placeholder and offers to set one.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('media_attachments')
    .addColumn('is_primary', 'boolean', (col) => col.notNull().defaultTo(false))
    .execute()

  await db.schema
    .createIndex('media_attachments_one_primary_per_owner')
    .unique()
    .on('media_attachments')
    .columns(['world_id', 'owner_kind', 'owner_id'])
    .where(sql.ref('is_primary'), '=', true)
    .execute()
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropIndex('media_attachments_one_primary_per_owner').execute()
  await db.schema.alterTable('media_attachments').dropColumn('is_primary').execute()
}
