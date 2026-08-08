import type { Kysely, Selectable } from 'kysely'
import type { Database, WorldsTable } from '../db/schema'
import type { WorldView } from './types'

export type WorldRow = Selectable<WorldsTable>

export async function insertWorld(
  db: Kysely<Database>,
  row: { id: string; owner_id: string; name: string; slug: string },
): Promise<void> {
  await db.insertInto('worlds').values(row).execute()
}

export function getWorldRow(db: Kysely<Database>, id: string): Promise<WorldRow | undefined> {
  return db.selectFrom('worlds').selectAll().where('id', '=', id).executeTakeFirst()
}

/** Existing slugs sharing a prefix — the candidate set for dedup on create. */
export async function slugsWithPrefix(db: Kysely<Database>, prefix: string): Promise<string[]> {
  const rows = await db
    .selectFrom('worlds')
    .select('slug')
    .where('slug', 'like', `${prefix}%`)
    .execute()
  return rows.map((r) => r.slug)
}

/** The name and its derived URL key move together — they are never set apart. */
export async function renameWorldRow(
  db: Kysely<Database>,
  id: string,
  next: { name: string; slug: string },
): Promise<void> {
  await db.updateTable('worlds').set(next).where('id', '=', id).execute()
}

/** Cascades to every world-scoped table via the `world_id` FKs. */
export async function deleteWorldRow(db: Kysely<Database>, id: string): Promise<void> {
  await db.deleteFrom('worlds').where('id', '=', id).execute()
}

/** Worlds the account is a member of, as views carrying the account's role. */
export function listWorldsForAccount(
  db: Kysely<Database>,
  accountId: string,
): Promise<WorldView[]> {
  return db
    .selectFrom('world_members')
    .innerJoin('worlds', 'worlds.id', 'world_members.world_id')
    .where('world_members.account_id', '=', accountId)
    .select([
      'worlds.id as id',
      'worlds.name as name',
      'worlds.slug as slug',
      'worlds.owner_id as ownerId',
      'world_members.role as role',
    ])
    .orderBy('worlds.name')
    .execute()
}

/** A single world view iff the account is a member of it. */
export function getWorldForAccount(
  db: Kysely<Database>,
  accountId: string,
  worldId: string,
): Promise<WorldView | undefined> {
  return db
    .selectFrom('world_members')
    .innerJoin('worlds', 'worlds.id', 'world_members.world_id')
    .where('world_members.account_id', '=', accountId)
    .where('world_members.world_id', '=', worldId)
    .select([
      'worlds.id as id',
      'worlds.name as name',
      'worlds.slug as slug',
      'worlds.owner_id as ownerId',
      'world_members.role as role',
    ])
    .executeTakeFirst()
}
