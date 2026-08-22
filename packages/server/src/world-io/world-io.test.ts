import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Kysely } from 'kysely'
import { describe, expect, it } from 'vitest'
import { resolveWorldContext } from '../authz/context'
import { ForbiddenError } from '../authz/errors'
import type { WorldContext } from '../data/context'
import { CONTENT_REPOS } from '../data/content-repos'
import { createNpc, getNpc } from '../data/npcs'
import { newId } from '../db/ids'
import { createDb } from '../db/kysely'
import { migrateToLatest } from '../db/migrator'
import type { Database } from '../db/schema'
import { withTestDatabase } from '../db/test-database'
import { seedDmManagerFixture } from '../importer/fixture'
import { SKIPPED_SUFFIX } from '../importer/mappers'
import { createTenancy } from '../tenancy'
import { exportWorld, type WorldExport } from './export'
import { importDmManagerWorld, importWorldExport } from './import'

async function makeAccount(db: Kysely<Database>, username: string): Promise<string> {
  const id = newId()
  await db.insertInto('accounts').values({ id, username, password_hash: 'h' }).execute()
  return id
}

const total = (counts: Record<string, number>) => Object.values(counts).reduce((a, b) => a + b, 0)

describe('world import/export', () => {
  it('round-trips a world: dm-manager import → export → re-import into a fresh database', async () => {
    let exported: WorldExport | undefined

    // Source database: migrate a dm-manager world up, then export it.
    await withTestDatabase(async (pool) => {
      const db = createDb(pool)
      await migrateToLatest(db)
      const ownerId = await makeAccount(db, 'dm')
      const dir = mkdtempSync(join(tmpdir(), 'cs-io-'))
      try {
        const sqlitePath = join(dir, 'world.db')
        seedDmManagerFixture(sqlitePath)
        const { slug, counts } = await importDmManagerWorld(db, ownerId, 'Chicago', sqlitePath)
        expect(total(counts)).toBe(34)
        const ctx = (await resolveWorldContext(db, ownerId, slug)) as WorldContext
        exported = await exportWorld(ctx)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    expect(exported).toBeDefined()
    // simulate a downloaded-then-uploaded JSON file
    const wire = JSON.parse(JSON.stringify(exported)) as WorldExport
    expect(wire.version).toBe(1)

    // Target database (fresh): create a world and import the wire payload.
    await withTestDatabase(async (pool) => {
      const db = createDb(pool)
      await migrateToLatest(db)
      const ownerId = await makeAccount(db, 'dm2')
      const world = await createTenancy(db).createWorld(ownerId, 'Chicago Copy')
      const counts = await importWorldExport(db, world.id, wire)
      // Still 47 rows across the target tables after migration 0017, because the
      // fold is one-for-one: 16 entities + 13 detail rows + 18 others
      // (maps/calendars/sessions + 2 currency attachments + the 9 relationships
      // that used to be 9 junction rows + map_pins/touch/media/meta).
      expect(total(counts)).toBe(47)

      const ctx = (await resolveWorldContext(db, ownerId, world.slug)) as WorldContext
      const npc = await getNpc(ctx, 'npc1')
      expect(npc?.name).toBe('The Prince')
      expect(npc?.world_id).toBe(world.id) // re-keyed to the new world
      const npcDetail = await db
        .selectFrom('npc_details')
        .select('species_id')
        .where('entity_id', '=', 'npc1')
        .executeTakeFirstOrThrow()
      expect(npcDetail.species_id).toBe('sp1') // entity FK preserved (now → entities.id)

      const cur = await db
        .selectFrom('currency_details')
        .selectAll()
        .where('world_id', '=', world.id)
        .where('entity_id', '=', 'cur1')
        .executeTakeFirstOrThrow()
      expect(Array.isArray(cur.denominations)).toBe(true) // jsonb array survived the round-trip
    })
  })

  it('strips the PC→account link, so an archive restores on a server that never had the account', async () => {
    // The regression this guards: `import.ts` inserts rows verbatim, and
    // `pc_details.account_id` is half a foreign key into `world_members`. Carry
    // it across and the restore fails on a server where that account and that
    // membership do not exist — a backup that errors exactly when it is needed.
    let exported: WorldExport | undefined

    await withTestDatabase(async (pool) => {
      const db = createDb(pool)
      await migrateToLatest(db)
      const tenancy = createTenancy(db)
      const dmId = await makeAccount(db, 'dm')
      const playerId = await makeAccount(db, 'player')
      const world = await tenancy.createWorld(dmId, 'W')
      await tenancy.grantMember(dmId, world.id, playerId)
      const dm = (await resolveWorldContext(db, dmId, world.slug)) as WorldContext

      await CONTENT_REPOS.pc!.create(dm, { name: 'Roland', account_id: playerId })
      exported = await exportWorld(dm)

      const rows = exported.tables.pc_details ?? []
      expect(rows).toHaveLength(1)
      expect(rows[0]).not.toHaveProperty('account_id')
      // The page itself still travels — only the account reference is dropped.
      expect(exported.tables.entities?.map((e) => e.name)).toContain('Roland')
    })

    // A FRESH database: no such account, no such membership. The import must
    // land anyway, with the character present and unlinked.
    await withTestDatabase(async (pool) => {
      const db = createDb(pool)
      await migrateToLatest(db)
      const tenancy = createTenancy(db)
      const otherDm = await makeAccount(db, 'other-dm')
      const target = await tenancy.createWorld(otherDm, 'Restored')
      const ctx = (await resolveWorldContext(db, otherDm, target.slug)) as WorldContext

      await importWorldExport(db, target.id, exported as WorldExport)

      const restored = await CONTENT_REPOS.pc!.list(ctx)
      expect(restored).toHaveLength(1)
      expect((restored[0] as unknown as Record<string, unknown>).name).toBe('Roland')
      expect((restored[0] as unknown as Record<string, unknown>).account_id).toBeNull()
    })
  })

  it('export is owner-only (never reachable by a player)', async () => {
    await withTestDatabase(async (pool) => {
      const db = createDb(pool)
      await migrateToLatest(db)
      const tenancy = createTenancy(db)
      const ownerId = await makeAccount(db, 'dm')
      const playerId = await makeAccount(db, 'player')
      const world = await tenancy.createWorldWithPlayer(ownerId, 'W', playerId)
      await createNpc((await resolveWorldContext(db, ownerId, world.slug)) as WorldContext, {
        name: 'Secret',
        visibility: 'dm_only',
      })

      const player = (await resolveWorldContext(db, playerId, world.slug)) as WorldContext
      await expect(exportWorld(player)).rejects.toBeInstanceOf(ForbiddenError)

      const owner = (await resolveWorldContext(db, ownerId, world.slug)) as WorldContext
      const dump = await exportWorld(owner)
      expect(dump.tables.entities).toHaveLength(1) // owner export includes the dm_only npc
    })
  })

  it('importing an empty export inserts nothing', async () => {
    await withTestDatabase(async (pool) => {
      const db = createDb(pool)
      await migrateToLatest(db)
      const ownerId = await makeAccount(db, 'dm')
      const world = await createTenancy(db).createWorld(ownerId, 'Empty')
      const counts = await importWorldExport(db, world.id, { version: 1, tables: {} })
      expect(total(counts)).toBe(0)
    })
  })

  /**
   * An archive downloaded BEFORE migration 0017 carries the nine junction tables
   * as top-level keys. They are no longer in `WORLD_CONTENT_TABLES`, so the import
   * loop walks past them — and without the fold, a file the user believes is a
   * complete backup comes back missing every language, magic system and pantheon
   * relation it held, with the import reporting success.
   */
  it('folds a PRE-0017 archive’s junction tables instead of walking past them', async () => {
    await withTestDatabase(async (pool) => {
      const db = createDb(pool)
      await migrateToLatest(db)
      const ownerId = await makeAccount(db, 'dm')
      const world = await createTenancy(db).createWorld(ownerId, 'Legacy Archive')

      const legacy: WorldExport = {
        version: 1,
        tables: {
          entities: [
            { id: 'npc1', kind: 'npc', name: 'The Prince' },
            { id: 'lg1', kind: 'language', name: 'Latin' },
            { id: 'ms1', kind: 'magic_system', name: 'Blood Magic' },
            { id: 'res1', kind: 'resource', name: 'Iron' },
            { id: 'loc1', kind: 'location', name: 'The Hollow' },
          ],
          npc_details: [{ entity_id: 'npc1' }],
          language_details: [{ entity_id: 'lg1' }],
          magic_system_details: [{ entity_id: 'ms1' }],
          resource_details: [{ entity_id: 'res1' }],
          // The legacy keys, exactly as a pre-0017 export wrote them.
          npc_languages: [{ npc_id: 'npc1', language_id: 'lg1', role: 'native' }],
          npc_magic_systems: [{ npc_id: 'npc1', magic_system_id: 'ms1' }],
          resource_locations: [{ resource_id: 'res1', location_id: 'loc1', notes: 'rich seam' }],
          // …and one that cannot be a relationship, which must not abort the whole
          // restore on a foreign-key violation.
          pc_languages: [{ pc_id: 'ghost', language_id: 'lg1', role: 'native' }],
        },
      }

      const counts = await importWorldExport(db, world.id, legacy)

      const rows = await db
        .selectFrom('entity_relationships')
        .select(['from_id', 'to_id', 'type', 'note', 'qualifier'])
        .where('world_id', '=', world.id)
        .orderBy('type')
        .execute()
      expect(rows).toEqual([
        { from_id: 'res1', to_id: 'loc1', type: 'found_at', note: 'rich seam', qualifier: null },
        { from_id: 'npc1', to_id: 'ms1', type: 'practises', note: '', qualifier: null },
        { from_id: 'npc1', to_id: 'lg1', type: 'speaks', note: '', qualifier: 'native' },
      ])
      // The unusable row is reported rather than dropped in silence.
      expect(counts.pc_languages).toBe(1)
      expect(counts[`pc_languages${SKIPPED_SUFFIX}`]).toBe(1)
    })
  })
})
