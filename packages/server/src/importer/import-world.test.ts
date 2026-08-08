import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Kysely } from 'kysely'
import { describe, expect, it } from 'vitest'
import { newId } from '../db/ids'
import { createDb } from '../db/kysely'
import { migrateToLatest } from '../db/migrator'
import type { Database } from '../db/schema'
import { withTestDatabase } from '../db/test-database'
import { seedDmManagerFixture } from './fixture'
import { importWorldDb } from './import-world'

const SOURCE_TABLE_COUNT = 34

async function seedWorld(db: Kysely<Database>, name: string): Promise<string> {
  const accountId = newId()
  await db
    .insertInto('accounts')
    .values({ id: accountId, username: `dm_${accountId}`, password_hash: 'h' })
    .execute()
  const worldId = newId()
  await db
    .insertInto('worlds')
    .values({ id: worldId, owner_id: accountId, name, slug: worldId })
    .execute()
  return worldId
}

describe('importWorldDb', () => {
  it('imports a dm-manager world DB: every table, ids preserved, native type conversions', async () => {
    await withTestDatabase(async (pool) => {
      const db = createDb(pool)
      await migrateToLatest(db)
      const worldId = await seedWorld(db, 'Imported')

      const dir = mkdtempSync(join(tmpdir(), 'cs-import-'))
      try {
        const sqlitePath = join(dir, 'world.db')
        seedDmManagerFixture(sqlitePath)

        const counts = await importWorldDb(db, worldId, sqlitePath)

        // every source table imported exactly one row
        const total = Object.values(counts).reduce((a, b) => a + b, 0)
        expect(total).toBe(SOURCE_TABLE_COUNT)
        expect(counts.npcs).toBe(1)
        expect(counts.npc_languages).toBe(1)
        expect(counts.dm_toolkit_meta).toBe(1)

        // base row → entities, kind-specific columns → <kind>_details (0005)
        const npc = await db
          .selectFrom('entities')
          .selectAll()
          .where('id', '=', 'npc1')
          .executeTakeFirstOrThrow()
        expect(npc.kind).toBe('npc') // discriminator stamped
        expect(npc.world_id).toBe(worldId) // tenancy injected
        expect(['public', 'dm_only', 'restricted']).toContain(npc.visibility) // INTEGER dm_only → visibility
        expect(npc.created_at).toBeInstanceOf(Date) // TEXT ISO → timestamptz/Date
        expect(npc.imported_metadata).not.toBeNull() // TEXT-JSON → jsonb object

        const npcDetail = await db
          .selectFrom('npc_details')
          .selectAll()
          .where('entity_id', '=', 'npc1')
          .executeTakeFirstOrThrow()
        expect(npcDetail.species_id).toBe('sp1') // FK preserved (now → entities.id)
        expect(npcDetail.culture_id).toBe('cu1')
        expect(npcDetail.occupation).toBe('') // drift column absent in source → DB default

        const cur = await db
          .selectFrom('currency_details')
          .selectAll()
          .where('entity_id', '=', 'cur1')
          .executeTakeFirstOrThrow()
        expect(Array.isArray(cur.denominations)).toBe(true) // jsonb array round-trip

        const st = await db
          .selectFrom('settlement_details')
          .selectAll()
          .where('entity_id', '=', 'st1')
          .executeTakeFirstOrThrow()
        expect(st.population).toBe(0) // drift column → DB default

        const lore = await db
          .selectFrom('entities')
          .selectAll()
          .where('id', '=', 'lore1')
          .executeTakeFirstOrThrow()
        expect(lore.deleted_at).toBeInstanceOf(Date) // nullable timestamp populated
        const loreDetail = await db
          .selectFrom('lore_article_details')
          .select('article_kind')
          .where('entity_id', '=', 'lore1')
          .executeTakeFirstOrThrow()
        expect(loreDetail.article_kind).not.toBeNull() // source `kind` → `article_kind`
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })
  })

  it('imports an empty source as zero rows (skips empty tables)', async () => {
    await withTestDatabase(async (pool) => {
      const db = createDb(pool)
      await migrateToLatest(db)
      const worldId = await seedWorld(db, 'Empty')

      const dir = mkdtempSync(join(tmpdir(), 'cs-import-empty-'))
      try {
        const sqlitePath = join(dir, 'empty.db')
        new DatabaseSync(sqlitePath).close() // valid sqlite file, no tables

        const counts = await importWorldDb(db, worldId, sqlitePath)
        expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBe(0)
        expect(counts.npcs).toBe(0)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })
  })
})
