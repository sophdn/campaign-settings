import type { Kysely } from 'kysely'
import { describe, expect, it } from 'vitest'
import { ForbiddenError } from '../authz/errors'
import { newId } from '../db/ids'
import { createDb } from '../db/kysely'
import { migrateToLatest } from '../db/migrator'
import type { Database } from '../db/schema'
import { withTestDatabase } from '../db/test-database'
import { changeEntityKind, KindChangeError } from './change-kind'
import { CONTENT_REPOS } from './content-repos'
import type { WorldContext } from './context'
import { createNpc, getNpc, softDeleteNpc } from './npcs'

async function seedWorld(
  db: Kysely<Database>,
): Promise<{ owner: WorldContext; player: WorldContext }> {
  const accountId = newId()
  await db
    .insertInto('accounts')
    .values({ id: accountId, username: `dm_${accountId}`, password_hash: 'h' })
    .execute()
  const worldId = newId()
  await db
    .insertInto('worlds')
    .values({ id: worldId, owner_id: accountId, name: 'W', slug: worldId })
    .execute()
  return {
    owner: { db, worldId, actor: { accountId, role: 'owner' } },
    player: { db, worldId, actor: { accountId: newId(), role: 'player' } },
  }
}

describe('changeEntityKind', () => {
  it('reclassifies npc → pc: keeps shared fields, drops the old detail, adds the new', async () => {
    await withTestDatabase(async (pool) => {
      const db = createDb(pool)
      await migrateToLatest(db)
      const { owner } = await seedWorld(db)
      const npc = await createNpc(owner, {
        name: 'Mara',
        description: 'a keeper',
        visibility: 'restricted',
        occupation: 'Tavern keeper',
      })

      const moved = await changeEntityKind(owner, npc.id, 'pc')
      expect(moved).toMatchObject({ id: npc.id, kind: 'pc', name: 'Mara', description: 'a keeper' })
      // shared field preserved, kind-specific (occupation) gone
      expect((moved as Record<string, unknown>).visibility).toBe('restricted')
      expect((moved as Record<string, unknown>).occupation).toBeUndefined()

      // no longer reachable as an npc; the npc detail row is gone, a pc one exists
      expect(await getNpc(owner, npc.id)).toBeUndefined()
      expect(await CONTENT_REPOS.pc!.get(owner, npc.id)).toMatchObject({ id: npc.id })
      const npcDetail = await db
        .selectFrom('npc_details')
        .selectAll()
        .where('entity_id', '=', npc.id)
        .executeTakeFirst()
      expect(npcDetail).toBeUndefined()
      const pcDetail = await db
        .selectFrom('pc_details')
        .selectAll()
        .where('entity_id', '=', npc.id)
        .executeTakeFirst()
      expect(pcDetail).toBeDefined()
    })
  })

  it('clears now-stale kind-specific junction rows on reclassify', async () => {
    await withTestDatabase(async (pool) => {
      const db = createDb(pool)
      await migrateToLatest(db)
      const { owner } = await seedWorld(db)
      const npc = await createNpc(owner, { name: 'Silas' })
      const lang = await CONTENT_REPOS.language!.create(owner, { name: 'Trade Cant' })
      await db
        .insertInto('npc_languages')
        .values({ world_id: owner.worldId, npc_id: npc.id, language_id: lang.id, role: 'native' })
        .execute()

      await changeEntityKind(owner, npc.id, 'settlement')

      // the npc-side junction row is cleared; the language entity is untouched
      const left = await db
        .selectFrom('npc_languages')
        .selectAll()
        .where('npc_id', '=', npc.id)
        .execute()
      expect(left).toHaveLength(0)
      expect(await CONTENT_REPOS.language!.get(owner, lang.id)).toMatchObject({ id: lang.id })
    })
  })

  it('no-ops when the target kind equals the current kind (detail untouched)', async () => {
    await withTestDatabase(async (pool) => {
      const db = createDb(pool)
      await migrateToLatest(db)
      const { owner } = await seedWorld(db)
      const npc = await createNpc(owner, { name: 'Oren', occupation: 'Watch captain' })

      const same = await changeEntityKind(owner, npc.id, 'npc')
      expect((same as Record<string, unknown>).occupation).toBe('Watch captain') // detail kept
    })
  })

  it('handles kinds without a detail table in both directions (location ↔ npc)', async () => {
    await withTestDatabase(async (pool) => {
      const db = createDb(pool)
      await migrateToLatest(db)
      const { owner } = await seedWorld(db)
      // location has no detail table → npc adds one
      const loc = await CONTENT_REPOS.location!.create(owner, { name: 'Old Harbor' })
      await changeEntityKind(owner, loc.id, 'npc')
      expect(
        await db
          .selectFrom('npc_details')
          .selectAll()
          .where('entity_id', '=', loc.id)
          .executeTakeFirst(),
      ).toBeDefined()

      // npc → location drops the detail again (target has none)
      await changeEntityKind(owner, loc.id, 'location')
      expect(
        await db
          .selectFrom('npc_details')
          .selectAll()
          .where('entity_id', '=', loc.id)
          .executeTakeFirst(),
      ).toBeUndefined()
      expect(await CONTENT_REPOS.location!.get(owner, loc.id)).toMatchObject({ id: loc.id })
    })
  })

  it('returns undefined for a missing or soft-deleted entity', async () => {
    await withTestDatabase(async (pool) => {
      const db = createDb(pool)
      await migrateToLatest(db)
      const { owner } = await seedWorld(db)
      expect(await changeEntityKind(owner, newId(), 'pc')).toBeUndefined()

      const npc = await createNpc(owner, { name: 'Doomed' })
      await softDeleteNpc(owner, npc.id)
      expect(await changeEntityKind(owner, npc.id, 'pc')).toBeUndefined()
    })
  })

  it('rejects a non-content target kind', async () => {
    await withTestDatabase(async (pool) => {
      const db = createDb(pool)
      await migrateToLatest(db)
      const { owner } = await seedWorld(db)
      const npc = await createNpc(owner, { name: 'X' })
      await expect(changeEntityKind(owner, npc.id, 'session')).rejects.toBeInstanceOf(
        KindChangeError,
      )
      await expect(changeEntityKind(owner, npc.id, 'banana')).rejects.toBeInstanceOf(
        KindChangeError,
      )
    })
  })

  it('is owner-only — a player cannot change an entity kind', async () => {
    await withTestDatabase(async (pool) => {
      const db = createDb(pool)
      await migrateToLatest(db)
      const { owner, player } = await seedWorld(db)
      const npc = await createNpc(owner, { name: 'X' })
      await expect(changeEntityKind(player, npc.id, 'pc')).rejects.toBeInstanceOf(ForbiddenError)
    })
  })
})
