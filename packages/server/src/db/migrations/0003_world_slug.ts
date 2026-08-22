import { nextAvailableSlug, slugify } from '@campaign-settings/shared'
import type { Kysely } from 'kysely'

/**
 * Give worlds a human-readable URL key. The web app routes on `slug` instead of
 * the opaque id (e.g. `/worlds/shadowrun-chicago`), and the membership gate
 * resolves the slug to the real id, so slugs must be unique. We add the column
 * nullable, backfill deterministically (oldest-first so existing links stay
 * stable), then enforce NOT NULL + UNIQUE.
 */

// Minimal typed view of the table for the backfill — kept local so this shipped
// migration never drifts with the live schema.
interface BackfillDb {
  worlds: { id: string; name: string; slug: string | null; created_at: Date }
}

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('worlds').addColumn('slug', 'text').execute()

  const typed = db as unknown as Kysely<BackfillDb>
  const worlds = await typed
    .selectFrom('worlds')
    .select(['id', 'name'])
    .orderBy('created_at')
    .orderBy('id')
    .execute()
  const taken = new Set<string>()
  for (const world of worlds) {
    const slug = nextAvailableSlug(slugify(world.name), taken)
    taken.add(slug)
    await typed.updateTable('worlds').set({ slug }).where('id', '=', world.id).execute()
  }

  await db.schema
    .alterTable('worlds')
    .alterColumn('slug', (c) => c.setNotNull())
    .execute()
  await db.schema.createIndex('worlds_slug_key').on('worlds').column('slug').unique().execute()
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropIndex('worlds_slug_key').execute()
  await db.schema.alterTable('worlds').dropColumn('slug').execute()
}
