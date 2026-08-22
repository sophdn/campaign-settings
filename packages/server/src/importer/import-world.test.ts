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

  /**
   * The nine junction tables have no Postgres table of their own since 0017, so
   * the importer translates them into `entity_relationships`. Nothing else in this
   * file would notice if that translation quietly wrote nothing: `counts` is keyed
   * off the SOURCE rows, so it would still say `npc_languages: 1`. This is the
   * test that makes a silent drop impossible — the exact data loss the task was
   * stopped mid-refactor to avoid.
   */
  it('translates all nine junction tables into relationships rather than dropping them', async () => {
    await withTestDatabase(async (pool) => {
      const db = createDb(pool)
      await migrateToLatest(db)
      const worldId = await seedWorld(db, 'Folded')

      const dir = mkdtempSync(join(tmpdir(), 'cs-import-fold-'))
      try {
        const sqlitePath = join(dir, 'world.db')
        seedDmManagerFixture(sqlitePath)

        const counts = await importWorldDb(db, worldId, sqlitePath)

        // The counts contract is unchanged: keyed by SOURCE table, so callers that
        // assert on `counts.npc_languages` keep working across the fold…
        expect(counts.npc_languages).toBe(1)
        expect(counts.resource_locations).toBe(1)
        // …and nothing was skipped, so no `_skipped` key appears at all.
        expect(Object.keys(counts).filter((k) => k.endsWith('_skipped'))).toEqual([])

        // …but the rows are now relationships. All nine, with the roles carried
        // into `qualifier` and `resource_locations.notes` into `note`.
        const rows = await db
          .selectFrom('entity_relationships')
          .select(['from_id', 'to_id', 'type', 'note', 'qualifier'])
          .where('world_id', '=', worldId)
          .orderBy(['type', 'from_id'])
          .execute()
        expect(rows).toEqual([
          { from_id: 'res1', to_id: 'loc1', type: 'found_at', note: '', qualifier: null },
          { from_id: 'cu1', to_id: 'ms1', type: 'practises', note: '', qualifier: null },
          { from_id: 'npc1', to_id: 'ms1', type: 'practises', note: '', qualifier: null },
          { from_id: 'pc1', to_id: 'ms1', type: 'practises', note: '', qualifier: null },
          { from_id: 'cu1', to_id: 'lg1', type: 'speaks', note: '', qualifier: 'liturgical' },
          { from_id: 'npc1', to_id: 'lg1', type: 'speaks', note: '', qualifier: 'native' },
          { from_id: 'pc1', to_id: 'lg1', type: 'speaks', note: '', qualifier: 'native' },
          { from_id: 'st1', to_id: 'lg1', type: 'speaks', note: '', qualifier: 'native' },
          { from_id: 'cu1', to_id: 'pan1', type: 'venerates', note: '', qualifier: null },
        ])

        // The two attachment tables did NOT fold; they still import as themselves.
        const attachments = await db
          .selectFrom('settlement_currency_attachments')
          .selectAll()
          .where('world_id', '=', worldId)
          .execute()
        expect(attachments).toHaveLength(1)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })
  })

  /**
   * The source is SQLite from a tool whose constraints we do not control, and the
   * fixture's own DDL declares no primary keys at all. So all three hazards that
   * migration 0017 mostly cannot hit are live here, and every one of them would
   * abort the ENTIRE import on an FK or CHECK violation — one malformed row
   * costing the user every other row in the file.
   */
  it('survives malformed junction rows: skips them, reports them, imports the rest', async () => {
    await withTestDatabase(async (pool) => {
      const db = createDb(pool)
      await migrateToLatest(db)
      const worldId = await seedWorld(db, 'Malformed')

      const dir = mkdtempSync(join(tmpdir(), 'cs-import-bad-'))
      try {
        const sqlitePath = join(dir, 'world.db')
        seedDmManagerFixture(sqlitePath)
        const src = new DatabaseSync(sqlitePath)
        src.exec(`
          -- an endpoint that is in no source entity table: would violate the FK
          insert into npc_languages values ('npc1','ghost-lang','native');
          -- a self-pair: would violate CHECK from_id <> to_id
          insert into npc_languages values ('npc1','npc1','native');
          -- a role outside every source vocabulary, from a hand-edited world.
          -- Needs a language the fixture has not already paired pc1 with, or the
          -- unique index would collapse it before the role is ever read.
          insert into languages values ('lg2','Enochian','Divine',0,'sigils','',0,null,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z',null);
          insert into pc_languages values ('pc1','lg2','ancestral');
          -- npc1 already practises ms1 via npc_magic_systems; this repeats the
          -- pair from a second source table that folds to the same type
          insert into culture_magic_systems values ('npc1','ms1');
          -- and a table where EVERY row is unusable, with the bad id on the FROM
          -- side: the loop must skip the insert entirely rather than send an empty
          -- VALUES list, and still report what it dropped
          delete from culture_pantheons;
          insert into culture_pantheons values ('ghost-culture','pan1');
        `)
        src.close()

        const counts = await importWorldDb(db, worldId, sqlitePath)

        // Two npc_languages rows are unusable, and they are REPORTED rather than
        // silently discarded — the source count still reads 3.
        expect(counts.npc_languages).toBe(3)
        expect(counts.npc_languages_skipped).toBe(2)
        // The cross-table duplicate is not "skipped": it reaches Postgres and the
        // unique index absorbs it, which is a collapse, not a loss.
        expect(counts.culture_magic_systems_skipped).toBeUndefined()
        // A table whose every row is unusable reports all of them and inserts none.
        expect(counts.culture_pantheons).toBe(1)
        expect(counts.culture_pantheons_skipped).toBe(1)
        const venerates = await db
          .selectFrom('entity_relationships')
          .selectAll()
          .where('world_id', '=', worldId)
          .where('type', '=', 'venerates')
          .execute()
        expect(venerates).toHaveLength(0)

        const speaks = await db
          .selectFrom('entity_relationships')
          .select(['from_id', 'to_id', 'note', 'qualifier'])
          .where('world_id', '=', worldId)
          .where('type', '=', 'speaks')
          .orderBy('from_id')
          .execute()
        expect(speaks).toEqual([
          { from_id: 'cu1', to_id: 'lg1', note: '', qualifier: 'liturgical' },
          { from_id: 'npc1', to_id: 'lg1', note: '', qualifier: 'native' },
          { from_id: 'pc1', to_id: 'lg1', note: '', qualifier: 'native' },
          // The unrecognized role is NOT dropped and NOT written to `qualifier`:
          // it survives in the free-text note, where it does not pretend to be a
          // member of a vocabulary that filters.
          { from_id: 'pc1', to_id: 'lg2', note: 'imported role: ancestral', qualifier: null },
          { from_id: 'st1', to_id: 'lg1', note: '', qualifier: 'native' },
        ])

        // `npc1` practises ms1 from BOTH npc_magic_systems and the injected
        // culture_magic_systems row — one relationship, not a crash.
        const practises = await db
          .selectFrom('entity_relationships')
          .select(['from_id', 'to_id'])
          .where('world_id', '=', worldId)
          .where('type', '=', 'practises')
          .where('from_id', '=', 'npc1')
          .execute()
        expect(practises).toHaveLength(1)
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
