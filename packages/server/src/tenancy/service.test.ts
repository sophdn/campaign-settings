import type { Kysely } from 'kysely'
import { describe, expect, it } from 'vitest'
import type { WorldContext } from '../data/context'
import { createNpc, listNpcs } from '../data/npcs'
import { newId } from '../db/ids'
import { createDb } from '../db/kysely'
import { migrateToLatest } from '../db/migrator'
import type { Database } from '../db/schema'
import { withTestDatabase } from '../db/test-database'
import { ForbiddenError, createTenancy } from './index'

async function makeAccount(db: Kysely<Database>, username: string): Promise<string> {
  const id = newId()
  await db.insertInto('accounts').values({ id, username, password_hash: 'h' }).execute()
  return id
}

describe('tenancy service', () => {
  it('a new world is visible to its owner and to nobody else', async () => {
    await withTestDatabase(async (pool) => {
      const db = createDb(pool)
      await migrateToLatest(db)
      const tenancy = createTenancy(db)
      const owner = await makeAccount(db, 'dm')
      const stranger = await makeAccount(db, 'rando')

      const world = await tenancy.createWorld(owner, 'Chicago')
      expect(world.role).toBe('owner')
      expect(world.slug).toBe('chicago')

      expect(await tenancy.listWorlds(owner)).toEqual([
        { id: world.id, name: 'Chicago', slug: 'chicago', ownerId: owner, role: 'owner' },
      ])
      expect(await tenancy.getWorld(owner, world.id)).toMatchObject({ role: 'owner' })

      expect(await tenancy.listWorlds(stranger)).toEqual([])
      expect(await tenancy.getWorld(stranger, world.id)).toBeNull()
    })
  })

  it('derives a slug from the name and deduplicates collisions', async () => {
    await withTestDatabase(async (pool) => {
      const db = createDb(pool)
      await migrateToLatest(db)
      const tenancy = createTenancy(db)
      const owner = await makeAccount(db, 'dm')

      const first = await tenancy.createWorld(owner, 'Shadowrun Chicago')
      const second = await tenancy.createWorld(owner, 'Shadowrun Chicago')
      const third = await tenancy.createWorld(owner, 'Shadowrun Chicago')

      expect(first.slug).toBe('shadowrun-chicago')
      expect(second.slug).toBe('shadowrun-chicago-2')
      expect(third.slug).toBe('shadowrun-chicago-3')
    })
  })

  it('granting a player adds visibility; revoking removes it; grants are idempotent', async () => {
    await withTestDatabase(async (pool) => {
      const db = createDb(pool)
      await migrateToLatest(db)
      const tenancy = createTenancy(db)
      const owner = await makeAccount(db, 'dm')
      const player = await makeAccount(db, 'player')

      const world = await tenancy.createWorld(owner, 'W')
      await tenancy.grantMember(owner, world.id, player)
      await tenancy.grantMember(owner, world.id, player) // idempotent re-grant

      const playerWorlds = await tenancy.listWorlds(player)
      expect(playerWorlds).toHaveLength(1)
      expect(playerWorlds[0]).toMatchObject({ id: world.id, role: 'player' })
      expect(await tenancy.getWorld(player, world.id)).toMatchObject({ role: 'player' })

      await tenancy.revokeMember(owner, world.id, player)
      expect(await tenancy.listWorlds(player)).toEqual([])
      expect(await tenancy.getWorld(player, world.id)).toBeNull()
    })
  })

  it('only the owner may grant, revoke, or delete; absent worlds are forbidden too', async () => {
    await withTestDatabase(async (pool) => {
      const db = createDb(pool)
      await migrateToLatest(db)
      const tenancy = createTenancy(db)
      const owner = await makeAccount(db, 'dm')
      const player = await makeAccount(db, 'player')
      const stranger = await makeAccount(db, 'rando')

      const world = await tenancy.createWorld(owner, 'W')
      await tenancy.grantMember(owner, world.id, player)

      await expect(tenancy.grantMember(player, world.id, stranger)).rejects.toBeInstanceOf(
        ForbiddenError,
      )
      await expect(tenancy.deleteWorld(player, world.id)).rejects.toBeInstanceOf(ForbiddenError)
      await expect(tenancy.revokeMember(stranger, world.id, player)).rejects.toBeInstanceOf(
        ForbiddenError,
      )
      // acting on a world that doesn't exist is forbidden, not a crash
      await expect(tenancy.deleteWorld(owner, newId())).rejects.toBeInstanceOf(ForbiddenError)
      // the owner cannot revoke their own ownership membership
      await expect(tenancy.revokeMember(owner, world.id, owner)).rejects.toBeInstanceOf(
        ForbiddenError,
      )
    })
  })

  it('renames a world and moves its URL with it', async () => {
    await withTestDatabase(async (pool) => {
      const db = createDb(pool)
      await migrateToLatest(db)
      const tenancy = createTenancy(db)
      const owner = await makeAccount(db, 'dm')

      const world = await tenancy.createWorld(owner, 'Chicago')
      const renamed = await tenancy.renameWorld(owner, world.id, 'VTM Detroit')

      expect(renamed).toEqual({
        id: world.id,
        name: 'VTM Detroit',
        slug: 'vtm-detroit',
        ownerId: owner,
        role: 'owner',
      })
      // The row itself, not just the returned view.
      expect(await tenancy.getWorld(owner, world.id)).toMatchObject({
        name: 'VTM Detroit',
        slug: 'vtm-detroit',
      })
    })
  })

  it('leaves the URL where it is when the name only changes cosmetically', async () => {
    await withTestDatabase(async (pool) => {
      const db = createDb(pool)
      await migrateToLatest(db)
      const tenancy = createTenancy(db)
      const owner = await makeAccount(db, 'dm')

      // Two worlds of the same name, so the second holds the deduplicated slug
      // — the case where a self-collision would show up as a drift to `-3`.
      await tenancy.createWorld(owner, 'Chicago')
      const second = await tenancy.createWorld(owner, 'Chicago')
      expect(second.slug).toBe('chicago-2')

      // Renaming it to what it is already called, twice.
      expect((await tenancy.renameWorld(owner, second.id, 'Chicago')).slug).toBe('chicago-2')
      expect((await tenancy.renameWorld(owner, second.id, 'Chicago')).slug).toBe('chicago-2')
      // And to a name that slugifies the same way.
      const punctuated = await tenancy.renameWorld(owner, second.id, '  Chicago!  ')
      expect(punctuated).toMatchObject({ name: '  Chicago!  ', slug: 'chicago-2' })
    })
  })

  it('deduplicates a rename onto a name another world already holds', async () => {
    await withTestDatabase(async (pool) => {
      const db = createDb(pool)
      await migrateToLatest(db)
      const tenancy = createTenancy(db)
      const owner = await makeAccount(db, 'dm')

      await tenancy.createWorld(owner, 'Detroit')
      const other = await tenancy.createWorld(owner, 'Chicago')

      // The unique index on worlds.slug is the real backstop; this is what
      // keeps a rename from reaching it.
      expect((await tenancy.renameWorld(owner, other.id, 'Detroit')).slug).toBe('detroit-2')
    })
  })

  it('is owner-only, and an absent world is refused rather than crashing', async () => {
    await withTestDatabase(async (pool) => {
      const db = createDb(pool)
      await migrateToLatest(db)
      const tenancy = createTenancy(db)
      const owner = await makeAccount(db, 'dm')
      const player = await makeAccount(db, 'player')
      const stranger = await makeAccount(db, 'rando')

      const world = await tenancy.createWorldWithPlayer(owner, 'Chicago', player)

      await expect(tenancy.renameWorld(player, world.id, 'Mine Now')).rejects.toBeInstanceOf(
        ForbiddenError,
      )
      await expect(tenancy.renameWorld(stranger, world.id, 'Mine Now')).rejects.toBeInstanceOf(
        ForbiddenError,
      )
      await expect(tenancy.renameWorld(owner, newId(), 'Nowhere')).rejects.toBeInstanceOf(
        ForbiddenError,
      )
      // Refused means unchanged, not merely un-returned.
      expect(await tenancy.getWorld(owner, world.id)).toMatchObject({ name: 'Chicago' })
    })
  })

  it('creates-and-grants in one step, and deleting a world cascades its data away', async () => {
    await withTestDatabase(async (pool) => {
      const db = createDb(pool)
      await migrateToLatest(db)
      const tenancy = createTenancy(db)
      const owner = await makeAccount(db, 'dm')
      const player = await makeAccount(db, 'player')

      const world = await tenancy.createWorldWithPlayer(owner, 'W', player)
      expect(await tenancy.getWorld(owner, world.id)).toMatchObject({ role: 'owner' })
      expect(await tenancy.getWorld(player, world.id)).toMatchObject({ role: 'player' })

      const ctx: WorldContext = {
        db,
        worldId: world.id,
        actor: { accountId: owner, role: 'owner' },
      }
      await createNpc(ctx, { name: 'The Prince' })
      expect(await listNpcs(ctx)).toHaveLength(1)

      await tenancy.deleteWorld(owner, world.id)
      expect(await tenancy.getWorld(owner, world.id)).toBeNull()
      expect(await tenancy.getWorld(player, world.id)).toBeNull()
      expect(await listNpcs(ctx)).toHaveLength(0) // world data cascaded away
    })
  })
})
