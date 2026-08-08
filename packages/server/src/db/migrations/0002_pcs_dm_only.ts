import type { Kysely } from 'kysely'

/**
 * Add dm_only to pcs so a PC can be hidden from the party (e.g. a DM-held PC
 * meant to be reassigned to an absent player). This makes pcs an ordinary
 * content table — same world-scoping / dm_only read filter / owner-only writes
 * as every other entity — so it no longer needs any special-case handling.
 * Default false: existing PCs stay visible.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('pcs')
    .addColumn('dm_only', 'boolean', (c) => c.notNull().defaultTo(false))
    .execute()
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('pcs').dropColumn('dm_only').execute()
}
