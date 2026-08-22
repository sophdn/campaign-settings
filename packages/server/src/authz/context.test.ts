import type { Kysely } from 'kysely'
import { describe, expect, it } from 'vitest'
import { createDb } from '../db/kysely'
import { newId } from '../db/ids'
import { migrateToLatest } from '../db/migrator'
import type { Database } from '../db/schema'
import { withTestDatabase } from '../db/test-database'
import { createTenancy } from '../tenancy'
import { resolveWorldContext } from './context'

async function makeAccount(db: Kysely<Database>, username: string): Promise<string> {
  const id = newId()
  await db.insertInto('accounts').values({ id, username, password_hash: 'h' }).execute()
  return id
}

describe('resolveWorldContext', () => {
  it('resolves a context only for a member, carrying their role', async () => {
    await withTestDatabase(async (pool) => {
      const db = createDb(pool)
      await migrateToLatest(db)
      const tenancy = createTenancy(db)
      const owner = await makeAccount(db, 'dm')
      const player = await makeAccount(db, 'player')
      const stranger = await makeAccount(db, 'rando')
      const world = await tenancy.createWorldWithPlayer(owner, 'W', player)

      // addressed by slug (the URL key); the context carries the real id
      expect(await resolveWorldContext(db, owner, world.slug)).toMatchObject({
        worldId: world.id,
        actor: { accountId: owner, role: 'owner' },
      })
      expect(await resolveWorldContext(db, player, world.slug)).toMatchObject({
        actor: { accountId: player, role: 'player' },
      })
      expect(await resolveWorldContext(db, stranger, world.slug)).toBeNull()
    })
  })

  it('a member of one world cannot resolve a context for another', async () => {
    await withTestDatabase(async (pool) => {
      const db = createDb(pool)
      await migrateToLatest(db)
      const tenancy = createTenancy(db)
      const a = await makeAccount(db, 'a')
      const b = await makeAccount(db, 'b')
      const worldA = await tenancy.createWorld(a, 'A')
      const worldB = await tenancy.createWorld(b, 'B')

      expect(await resolveWorldContext(db, a, worldB.slug)).toBeNull()
      expect(await resolveWorldContext(db, b, worldA.slug)).toBeNull()
    })
  })
})
