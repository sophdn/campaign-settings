import type { Kysely } from 'kysely'
import { describe, expect, it } from 'vitest'
import { newId } from '../db/ids'
import { createDb } from '../db/kysely'
import { migrateToLatest } from '../db/migrator'
import type { Database } from '../db/schema'
import { withTestDatabase } from '../db/test-database'
import type { WorldContext } from './context'
import { createNpc, getNpc, listNpcs, softDeleteNpc, updateNpc } from './npcs'

/** Seed an owner account + world, return a WorldContext bound to it. */
async function seedWorld(db: Kysely<Database>, name: string): Promise<WorldContext> {
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
  return { db, worldId, actor: { accountId, role: 'owner' } }
}

describe('npcs repository', () => {
  it('round-trips CRUD scoped to the world; soft-delete hides the row', async () => {
    await withTestDatabase(async (pool) => {
      const db = createDb(pool)
      await migrateToLatest(db)
      const ctx = await seedWorld(db, 'Chicago')

      const created = await createNpc(ctx, {
        name: 'The Prince',
        visibility: 'dm_only',
        occupation: 'Prince',
      })
      expect(created.world_id).toBe(ctx.worldId)
      expect(created.visibility).toBe('dm_only')
      expect(created.id).toBeTruthy()

      expect((await getNpc(ctx, created.id))?.name).toBe('The Prince')

      const updated = await updateNpc(ctx, created.id, { name: 'The Former Prince' })
      expect(updated?.name).toBe('The Former Prince')
      expect(await listNpcs(ctx)).toHaveLength(1)

      expect(await softDeleteNpc(ctx, created.id)).toBe(true)
      expect(await getNpc(ctx, created.id)).toBeUndefined()
      expect(await listNpcs(ctx)).toHaveLength(0)
      // deleting an already-gone row is a no-op
      expect(await softDeleteNpc(ctx, created.id)).toBe(false)
    })
  })

  it('cannot read or write across worlds (tenancy wall)', async () => {
    await withTestDatabase(async (pool) => {
      const db = createDb(pool)
      await migrateToLatest(db)
      const a = await seedWorld(db, 'World A')
      const b = await seedWorld(db, 'World B')

      const npc = await createNpc(a, { name: 'A-secret' }, 'fixed-id-1')

      // B's context is blind to A's row through every door
      expect(await getNpc(b, npc.id)).toBeUndefined()
      expect(await updateNpc(b, npc.id, { name: 'hijack' })).toBeUndefined()
      expect(await softDeleteNpc(b, npc.id)).toBe(false)
      expect(await listNpcs(b)).toHaveLength(0)

      // A is untouched
      expect((await getNpc(a, npc.id))?.name).toBe('A-secret')
    })
  })
})
