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

  it('clears now-stale kind-specific attachment rows on reclassify', async () => {
    await withTestDatabase(async (pool) => {
      const db = createDb(pool)
      await migrateToLatest(db)
      const { owner } = await seedWorld(db)
      const settlement = await CONTENT_REPOS.settlement!.create(owner, { name: 'Chicago' })
      const currency = await CONTENT_REPOS.currency!.create(owner, { name: 'Dollar' })
      await db
        .insertInto('settlement_currency_attachments')
        .values({
          id: newId(),
          world_id: owner.worldId,
          settlement_id: settlement.id,
          currency_id: currency.id,
        })
        .execute()

      await changeEntityKind(owner, settlement.id, 'location')

      // the settlement-side attachment row is cleared; the currency is untouched
      const left = await db
        .selectFrom('settlement_currency_attachments')
        .selectAll()
        .where('settlement_id', '=', settlement.id)
        .execute()
      expect(left).toHaveLength(0)
      expect(await CONTENT_REPOS.currency!.get(owner, currency.id)).toMatchObject({
        id: currency.id,
      })
    })
  })

  /**
   * The counterpart decision to the test above, and the reason it is a test rather
   * than only a comment: 0017 folded the nine junction tables into
   * `entity_relationships`, and the cleanup deliberately did NOT follow them in.
   * Nothing constrains a relationship's endpoint kinds at the write boundary, so
   * clearing here would destroy rows the create path accepts. If someone later
   * adds relationships to `KIND_ATTACHMENT_REFS` on the assumption that the
   * omission was an oversight, this fails and says so.
   */
  it('KEEPS typed relationships on reclassify — they are kind-agnostic by design', async () => {
    await withTestDatabase(async (pool) => {
      const db = createDb(pool)
      await migrateToLatest(db)
      const { owner } = await seedWorld(db)
      const npc = await createNpc(owner, { name: 'Silas' })
      const lang = await CONTENT_REPOS.language!.create(owner, { name: 'Trade Cant' })
      await db
        .insertInto('entity_relationships')
        .values({
          id: newId(),
          world_id: owner.worldId,
          from_id: npc.id,
          to_id: lang.id,
          type: 'speaks',
          qualifier: 'native',
        })
        .execute()

      await changeEntityKind(owner, npc.id, 'settlement')

      // Reclassifying the speaker does not stop them speaking the language.
      const kept = await db
        .selectFrom('entity_relationships')
        .selectAll()
        .where('from_id', '=', npc.id)
        .execute()
      expect(kept).toHaveLength(1)
      expect(kept[0]).toMatchObject({ type: 'speaks', qualifier: 'native', to_id: lang.id })
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
