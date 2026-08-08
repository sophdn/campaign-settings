import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Kysely } from 'kysely'
import { describe, expect, it } from 'vitest'
import { resolveWorldContext } from '../authz/context'
import { ForbiddenError } from '../authz/errors'
import type { WorldContext } from '../data/context'
import { createNpc, getNpc } from '../data/npcs'
import { newId } from '../db/ids'
import { createDb } from '../db/kysely'
import { migrateToLatest } from '../db/migrator'
import type { Database } from '../db/schema'
import { withTestDatabase } from '../db/test-database'
import { seedDmManagerFixture } from '../importer/fixture'
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
      // 47 rows across the target tables: 16 entities + 13 detail rows + 18 others
      // (maps/calendars/sessions + 11 junctions + map_pins/touch/media/meta).
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
})
