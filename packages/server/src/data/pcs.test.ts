import type { Kysely } from 'kysely'
import { describe, expect, it } from 'vitest'
import { createContentRepository } from '../authz/content'
import { newId } from '../db/ids'
import { DETAIL_SPECS } from './entity-details'
import { createDb } from '../db/kysely'
import { migrateToLatest } from '../db/migrator'
import type { Database } from '../db/schema'
import { withTestDatabase } from '../db/test-database'
import type { WorldContext } from './context'

// pcs is an ordinary content kind (it carries visibility), so it flows through
// the same authorization seam as every other entity — the `entities` base table
// filtered to kind `pc`, with its detail table merged in.
const pcs = createContentRepository('entities', { kind: 'pc', detail: DETAIL_SPECS.pc })

/** Seed an owner account + world, return an owner-bound WorldContext. */
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

describe('pcs as a content entity', () => {
  it('hides a dm_only PC from players but shows it to the owner; players cannot write', async () => {
    await withTestDatabase(async (pool) => {
      const db = createDb(pool)
      await migrateToLatest(db)
      const owner = await seedWorld(db, 'Chicago')
      const player: WorldContext = { ...owner, actor: { accountId: newId(), role: 'player' } }

      await pcs.create(owner, { name: 'Visible PC' })
      const hidden = await pcs.create(owner, { name: 'Hidden DM-PC', visibility: 'dm_only' })

      // owner sees every PC; the player sees only the non-hidden one
      expect(await pcs.list(owner)).toHaveLength(2)
      const playerPcs = await pcs.list(player)
      expect(playerPcs).toHaveLength(1)
      expect(playerPcs.map((p) => p.id)).not.toContain(hidden.id)
      expect(await pcs.get(player, hidden.id)).toBeUndefined()

      // revealing the PC (dm_only -> false) makes it visible to the player
      await pcs.update(owner, hidden.id, { visibility: 'public' })
      expect(await pcs.list(player)).toHaveLength(2)

      // players can never mutate PCs (owner-only writes)
      await expect(pcs.create(player, { name: 'nope' })).rejects.toThrow()
    })
  })
})
