import { sql } from 'kysely'
import type { Migration } from 'kysely/migration'
import { describe, expect, it } from 'vitest'
import { createDb } from '../kysely'
import { MIGRATIONS } from '../migrations'
import { createMigrator, migrateToLatest } from '../migrator'
import { withTestDatabase } from '../test-database'

/**
 * Migration 0017 — the junction fold, tested on real rows.
 *
 * The point of this file is that 0017 MOVES DATA, which no amount of typechecking
 * covers: the nine source tables are gone by the time anything else runs, so if
 * the copy is wrong the rows are simply not there and every later test still
 * passes. So each test seeds the pre-0017 schema through migration 0016, writes
 * junction rows by hand, applies 0017, and reads what landed.
 */

/** Migrations up to and including `lastKey` — same idiom as `migrator.test.ts`. */
const onlyThrough = (lastKey: string): Record<string, Migration> =>
  Object.fromEntries(Object.entries(MIGRATIONS).filter(([k]) => k <= lastKey))

const THROUGH_0016 = onlyThrough('0016_map_visibility')
const THROUGH_0017 = onlyThrough('0017_fold_junctions_into_relationships')

/** The world + entities every test folds rows between. */
async function seed(db: ReturnType<typeof createDb>): Promise<void> {
  await db.insertInto('accounts').values({ id: 'a1', username: 'dm', password_hash: 'h' }).execute()
  await db.insertInto('worlds').values({ id: 'w1', owner_id: 'a1', name: 'W', slug: 'w' }).execute()
  await db
    .insertInto('entities')
    .values([
      { id: 'cu1', world_id: 'w1', kind: 'culture', name: 'Camarilla' },
      { id: 'npc1', world_id: 'w1', kind: 'npc', name: 'The Prince' },
      { id: 'pc1', world_id: 'w1', kind: 'pc', name: 'Hero' },
      { id: 'st1', world_id: 'w1', kind: 'settlement', name: 'Chicago' },
      { id: 'lg1', world_id: 'w1', kind: 'language', name: 'Latin' },
      { id: 'ms1', world_id: 'w1', kind: 'magic_system', name: 'Blood Magic' },
      { id: 'pan1', world_id: 'w1', kind: 'pantheon', name: 'Old Gods' },
      { id: 'res1', world_id: 'w1', kind: 'resource', name: 'Iron' },
      { id: 'loc1', world_id: 'w1', kind: 'location', name: 'The Hollow' },
    ])
    .execute()
}

/** Every relationship in the world, in a shape that is pleasant to assert on. */
async function relationships(
  db: ReturnType<typeof createDb>,
): Promise<
  { from_id: string; to_id: string; type: string; note: string; qualifier: string | null }[]
> {
  const rows = await sql<{
    from_id: string
    to_id: string
    type: string
    note: string
    qualifier: string | null
  }>`select from_id, to_id, type, note, qualifier from entity_relationships
       order by type, from_id, to_id`.execute(db)
  return rows.rows
}

describe('0017 — folding the nine junctions into entity_relationships', () => {
  it('carries every junction across with the right type, qualifier and note', async () => {
    await withTestDatabase(async (pool) => {
      const db = createDb(pool)
      await migrateToLatest(db, THROUGH_0016)
      await seed(db)

      // One row in each of the nine, exercising all four new types and both of
      // the qualifier vocabularies (`liturgical` is culture-only; `trade` is not).
      await sql`insert into culture_languages values ('w1','cu1','lg1','liturgical')`.execute(db)
      await sql`insert into npc_languages values ('w1','npc1','lg1','native')`.execute(db)
      await sql`insert into pc_languages values ('w1','pc1','lg1','trade')`.execute(db)
      await sql`insert into settlement_languages values ('w1','st1','lg1','secondary')`.execute(db)
      await sql`insert into culture_magic_systems values ('w1','cu1','ms1')`.execute(db)
      await sql`insert into npc_magic_systems values ('w1','npc1','ms1')`.execute(db)
      await sql`insert into pc_magic_systems values ('w1','pc1','ms1')`.execute(db)
      await sql`insert into culture_pantheons values ('w1','cu1','pan1')`.execute(db)
      await sql`insert into resource_locations values ('w1','res1','loc1','rich seam')`.execute(db)

      await migrateToLatest(db)

      expect(await relationships(db)).toEqual([
        // resource_locations.notes lands on `note`, NOT on `qualifier` — it is
        // prose, and the qualifier column exists to stay filterable.
        { from_id: 'res1', to_id: 'loc1', type: 'found_at', note: 'rich seam', qualifier: null },
        { from_id: 'cu1', to_id: 'ms1', type: 'practises', note: '', qualifier: null },
        { from_id: 'npc1', to_id: 'ms1', type: 'practises', note: '', qualifier: null },
        { from_id: 'pc1', to_id: 'ms1', type: 'practises', note: '', qualifier: null },
        { from_id: 'cu1', to_id: 'lg1', type: 'speaks', note: '', qualifier: 'liturgical' },
        { from_id: 'npc1', to_id: 'lg1', type: 'speaks', note: '', qualifier: 'native' },
        { from_id: 'pc1', to_id: 'lg1', type: 'speaks', note: '', qualifier: 'trade' },
        { from_id: 'st1', to_id: 'lg1', type: 'speaks', note: '', qualifier: 'secondary' },
        { from_id: 'cu1', to_id: 'pan1', type: 'venerates', note: '', qualifier: null },
      ])
    })
  })

  it('drops all nine source tables and leaves the two attachment tables alone', async () => {
    await withTestDatabase(async (pool) => {
      const db = createDb(pool)
      await migrateToLatest(db, THROUGH_0016)
      await migrateToLatest(db)

      const { rows } = await sql<{ table_name: string }>`
        select table_name from information_schema.tables
        where table_schema = 'public' order by table_name`.execute(db)
      const names = new Set(rows.map((r) => r.table_name))

      for (const gone of [
        'culture_languages',
        'culture_magic_systems',
        'culture_pantheons',
        'npc_languages',
        'npc_magic_systems',
        'pc_languages',
        'pc_magic_systems',
        'settlement_languages',
        'resource_locations',
      ]) {
        expect(names.has(gone), `${gone} should be gone`).toBe(false)
      }
      // The category error the task text made, now a test: these two carry
      // `visibility` + `deleted_at` and are content rows on the seam. Folding them
      // into a table with neither would have destroyed both.
      expect(names.has('settlement_currency_attachments')).toBe(true)
      expect(names.has('organization_currency_attachments')).toBe(true)
    })
  })

  it('collapses a pair that two source tables both fold to one type', async () => {
    await withTestDatabase(async (pool) => {
      const db = createDb(pool)
      await migrateToLatest(db, THROUGH_0016)
      await seed(db)

      // The only reachable duplicate: each junction's composite PK makes a repeat
      // impossible WITHIN a table, but `npc_languages` and `pc_languages` both
      // fold to `speaks`, so one id present in both yields the same
      // (world, from, to, type) twice. ON CONFLICT DO NOTHING is what absorbs it.
      await sql`insert into npc_languages values ('w1','npc1','lg1','native')`.execute(db)
      await sql`insert into pc_languages values ('w1','npc1','lg1','trade')`.execute(db)

      await migrateToLatest(db)

      const speaks = await relationships(db)
      expect(speaks).toHaveLength(1)
      // Which of the two survives is whichever the FOLDS order reaches first, and
      // that order is `culture, npc, pc, settlement` — so the npc row's `native`.
      expect(speaks[0]).toMatchObject({ from_id: 'npc1', to_id: 'lg1', qualifier: 'native' })
    })
  })

  it('skips a self-pair the junction PK allowed but the CHECK constraint refuses', async () => {
    await withTestDatabase(async (pool) => {
      const db = createDb(pool)
      await migrateToLatest(db, THROUGH_0016)
      await seed(db)

      // `resource_locations` PKs on (resource_id, location_id), which happily
      // stores (loc1, loc1); `entity_relationships` has CHECK from_id <> to_id.
      // Without the `where from <> to` guard this aborts the whole migration.
      await sql`insert into resource_locations values ('w1','loc1','loc1','')`.execute(db)
      await sql`insert into resource_locations values ('w1','res1','loc1','kept')`.execute(db)

      await migrateToLatest(db)

      const rows = await relationships(db)
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ from_id: 'res1', to_id: 'loc1', note: 'kept' })
    })
  })

  it('carries relations whose endpoint is soft-deleted', async () => {
    await withTestDatabase(async (pool) => {
      const db = createDb(pool)
      await migrateToLatest(db, THROUGH_0016)
      await seed(db)
      await db
        .updateTable('entities')
        .set({ deleted_at: new Date() })
        .where('id', '=', 'lg1')
        .execute()
      await sql`insert into npc_languages values ('w1','npc1','lg1','native')`.execute(db)

      await migrateToLatest(db)

      // The endpoint join deliberately does not filter `deleted_at`: a soft-deleted
      // entity is still a row, and a fold that dropped its relations would lose
      // data it promises to preserve. Restoring the language must restore its
      // relationships with it.
      expect(await relationships(db)).toHaveLength(1)
    })
  })

  it('is a no-op on an empty world rather than a failure', async () => {
    await withTestDatabase(async (pool) => {
      const db = createDb(pool)
      await migrateToLatest(db, THROUGH_0016)
      await seed(db)

      await migrateToLatest(db)

      expect(await relationships(db)).toEqual([])
    })
  })

  it('down() restores the nine tables, drops qualifier, and destroys no relationship', async () => {
    await withTestDatabase(async (pool) => {
      const db = createDb(pool)
      await migrateToLatest(db, THROUGH_0016)
      await seed(db)
      await sql`insert into npc_languages values ('w1','npc1','lg1','native')`.execute(db)
      // THROUGH_0017, not the whole set: the step down below is meant to be
      // 0017's, and migrating to whatever is newest would silently retarget it
      // at the last migration ever added. Every future migration would then
      // break this test in a way that reads as a fault in the new migration.
      await migrateToLatest(db, THROUGH_0017)

      // One step down, not the whole stack: this asserts 0017's own reversal.
      const { error } = await createMigrator(db, THROUGH_0017).migrateDown()
      expect(error).toBeUndefined()

      // The table is back, and empty — `down` moves no rows.
      const back = await sql<{ n: string }>`select count(*) as n from npc_languages`.execute(db)
      expect(back.rows[0]?.n).toBe('0')
      // The relationship is NOT destroyed; it stays where `up` put it, which is
      // what makes up → down → up stable.
      const kept = await sql<{ n: string }>`
        select count(*) as n from entity_relationships where type = 'speaks'`.execute(db)
      expect(kept.rows[0]?.n).toBe('1')
      // `qualifier` went with the column, and says so in the docstring.
      const col = await sql<{ column_name: string }>`
        select column_name from information_schema.columns
        where table_name = 'entity_relationships' and column_name = 'qualifier'`.execute(db)
      expect(col.rows).toHaveLength(0)

      // …and re-applying finds nine empty tables and copies nothing new.
      await migrateToLatest(db)
      expect(await relationships(db)).toHaveLength(1)
    })
  })
})
