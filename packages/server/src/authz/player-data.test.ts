import type { Kysely } from 'kysely'
import { describe, expect, it } from 'vitest'
import type { WorldContext } from '../data/context'
import { newId } from '../db/ids'
import { createDb } from '../db/kysely'
import { migrateToLatest } from '../db/migrator'
import type { Database, MemberRole } from '../db/schema'
import { withTestDatabase } from '../db/test-database'
import { createTenancy } from '../tenancy'
import { resolveWorldContext } from './context'
import { ForbiddenError } from './errors'
import { assertPlayerDataWrite, playerDataReadScope } from './player-data'

function ctxFor(accountId: string, role: MemberRole): WorldContext {
  return { db: {} as unknown as Kysely<Database>, worldId: 'w', actor: { accountId, role } }
}

async function makeAccount(db: Kysely<Database>, username: string): Promise<string> {
  const id = newId()
  await db.insertInto('accounts').values({ id, username, password_hash: 'h' }).execute()
  return id
}

describe('player-data authorization', () => {
  it('read scope: the DM sees all, a player is restricted to their own', () => {
    expect(playerDataReadScope(ctxFor('dm', 'owner'))).toBeNull()
    expect(playerDataReadScope(ctxFor('p1', 'player'))).toEqual({ ownerId: 'p1' })
  })

  it('write: only the owning account may write its player data', () => {
    expect(() => assertPlayerDataWrite(ctxFor('p1', 'player'), 'p1')).not.toThrow()
    expect(() => assertPlayerDataWrite(ctxFor('p1', 'player'), 'p2')).toThrow(ForbiddenError)
    // even the DM may not write another account's player data
    expect(() => assertPlayerDataWrite(ctxFor('dm', 'owner'), 'p1')).toThrow(ForbiddenError)
  })

  it('applied to player_notes: a player reads only their own; the DM reads all', async () => {
    await withTestDatabase(async (pool) => {
      const db = createDb(pool)
      await migrateToLatest(db)
      const tenancy = createTenancy(db)
      const dm = await makeAccount(db, 'dm')
      const p1 = await makeAccount(db, 'p1')
      const p2 = await makeAccount(db, 'p2')
      const world = await tenancy.createWorld(dm, 'W')
      await tenancy.grantMember(dm, world.id, p1)
      await tenancy.grantMember(dm, world.id, p2)
      await db
        .insertInto('player_notes')
        .values({ id: newId(), world_id: world.id, author_id: p1, body: 'N1' })
        .execute()
      await db
        .insertInto('player_notes')
        .values({ id: newId(), world_id: world.id, author_id: p2, body: 'N2' })
        .execute()

      // how a player-data repo (task 13) will apply the scope
      async function read(ctx: WorldContext) {
        let q = db.selectFrom('player_notes').selectAll().where('world_id', '=', world.id)
        const scope = playerDataReadScope(ctx)
        if (scope) q = q.where('author_id', '=', scope.ownerId)
        return q.execute()
      }

      const p1Ctx = (await resolveWorldContext(db, p1, world.slug)) as WorldContext
      const dmCtx = (await resolveWorldContext(db, dm, world.slug)) as WorldContext

      const ownRows = await read(p1Ctx)
      expect(ownRows).toHaveLength(1)
      expect(ownRows[0]?.author_id).toBe(p1)
      expect(await read(dmCtx)).toHaveLength(2)
    })
  })
})
