import type { Kysely } from 'kysely'
import { describe, expect, it } from 'vitest'
import { resolveWorldContext } from '../authz/context'
import { ForbiddenError } from '../authz/errors'
import { newId } from '../db/ids'
import { createDb } from '../db/kysely'
import { migrateToLatest } from '../db/migrator'
import type { Database } from '../db/schema'
import { withTestDatabase } from '../db/test-database'
import { createTenancy } from '../tenancy'
import { CONTENT_REPOS } from './content-repos'
import type { WorldContext } from './context'
import {
  assertLinkableAccount,
  findPcForAccount,
  listParty,
  PcAccountLinkError,
} from './pc-account'

async function makeAccount(db: Kysely<Database>, username: string): Promise<string> {
  const id = newId()
  await db.insertInto('accounts').values({ id, username, password_hash: 'h' }).execute()
  return id
}

/** A world with a DM, two member players, and one account who is NOT a member. */
async function setup(db: Kysely<Database>) {
  const tenancy = createTenancy(db)
  const dmId = await makeAccount(db, 'dm')
  const p1Id = await makeAccount(db, 'p1')
  const p2Id = await makeAccount(db, 'p2')
  const strangerId = await makeAccount(db, 'stranger')
  const world = await tenancy.createWorld(dmId, 'W')
  await tenancy.grantMember(dmId, world.id, p1Id)
  await tenancy.grantMember(dmId, world.id, p2Id)
  const dm = (await resolveWorldContext(db, dmId, world.slug)) as WorldContext
  const p1 = (await resolveWorldContext(db, p1Id, world.slug)) as WorldContext
  return { tenancy, world, dm, p1, dmId, p1Id, p2Id, strangerId }
}

const pcs = () => CONTENT_REPOS.pc!

describe('the PC → account link', () => {
  it('refuses an account that is not a member of this world, with a sentence', async () => {
    await withTestDatabase(async (pool) => {
      const db = createDb(pool)
      await migrateToLatest(db)
      const { dm, p1Id, strangerId } = await setup(db)

      const self = newId()
      await expect(
        assertLinkableAccount(dm, self, { account_id: strangerId }),
      ).rejects.toBeInstanceOf(PcAccountLinkError)
      // A member passes, and so does every shape of "not setting it".
      await expect(assertLinkableAccount(dm, self, { account_id: p1Id })).resolves.toBeUndefined()
      await expect(
        assertLinkableAccount(dm, self, { name: 'no link here' }),
      ).resolves.toBeUndefined()
      await expect(assertLinkableAccount(dm, self, { account_id: null })).resolves.toBeUndefined()
      await expect(assertLinkableAccount(dm, self, { account_id: '' })).resolves.toBeUndefined()
    })
  })

  it('is enforced by the DATABASE, not only by the check above', async () => {
    // The guard is for the error message; this is the guarantee. A write that
    // goes around the route must still be refused, or the "constraint rather
    // than convention" claim in migration 0018 is not true.
    await withTestDatabase(async (pool) => {
      const db = createDb(pool)
      await migrateToLatest(db)
      const { dm, strangerId } = await setup(db)

      const pc = await pcs().create(dm, { name: 'Roland' })
      await expect(pcs().update(dm, pc.id, { account_id: strangerId })).rejects.toThrow()
    })
  })

  it('releases the character when the player leaves, and keeps the page', async () => {
    await withTestDatabase(async (pool) => {
      const db = createDb(pool)
      await migrateToLatest(db)
      const { tenancy, world, dm, dmId, p1Id } = await setup(db)

      const pc = await pcs().create(dm, { name: 'Roland', account_id: p1Id })
      expect((await findPcForAccount(dm, p1Id))?.id).toBe(pc.id)

      await tenancy.revokeMember(dmId, world.id, p1Id)

      // Nothing in `purgeMembership` clears this — the foreign key does.
      const after = await pcs().get(dm, pc.id)
      expect(after).toBeDefined()
      expect((after as unknown as Record<string, unknown>).name).toBe('Roland')
      expect((after as unknown as Record<string, unknown>).account_id).toBeNull()
      expect(await findPcForAccount(dm, p1Id)).toBeUndefined()
    })
  })

  it('holds one character per player, and says which one has the seat', async () => {
    await withTestDatabase(async (pool) => {
      const db = createDb(pool)
      await migrateToLatest(db)
      const { dm, p1Id } = await setup(db)

      const first = await pcs().create(dm, { name: 'Roland', account_id: p1Id })
      const second = await pcs().create(dm, { name: 'Roland II' })

      // The guard names the character already linked and the player by
      // username, because "unique violation" is not an instruction.
      await expect(assertLinkableAccount(dm, second.id, { account_id: p1Id })).rejects.toThrow(
        /p1 already plays Roland/,
      )

      // Re-saving the SAME character with the SAME player is not a conflict —
      // `selfId` is what keeps a no-op edit from reporting itself.
      await expect(
        assertLinkableAccount(dm, first.id, { account_id: p1Id }),
      ).resolves.toBeUndefined()

      // Retire the first by clearing its link; the seat opens and its page stays.
      await pcs().update(dm, first.id, { account_id: null })
      await pcs().update(dm, second.id, { account_id: p1Id })

      expect((await findPcForAccount(dm, p1Id))?.name).toBe('Roland II')
      expect((await pcs().get(dm, first.id)) as unknown as Record<string, unknown>).toMatchObject({
        name: 'Roland',
        account_id: null,
      })
    })
  })

  it('is enforced by the DATABASE, so a second link cannot slip past the guard', async () => {
    await withTestDatabase(async (pool) => {
      const db = createDb(pool)
      await migrateToLatest(db)
      const { dm, p1Id } = await setup(db)

      await pcs().create(dm, { name: 'Roland', account_id: p1Id })
      const second = await pcs().create(dm, { name: 'Roland II' })

      await expect(pcs().update(dm, second.id, { account_id: p1Id })).rejects.toThrow()
    })
  })

  it('a player cannot set or clear the link, not even on their own character', async () => {
    await withTestDatabase(async (pool) => {
      const db = createDb(pool)
      await migrateToLatest(db)
      const { dm, p1, p1Id, p2Id } = await setup(db)

      const mine = await pcs().create(dm, { name: 'Roland', account_id: p1Id })

      // Content writes are owner-only, and the link is content. Three attempts:
      // claim someone else's, hand mine away, and unlink my own.
      await expect(pcs().update(p1, mine.id, { account_id: p1Id })).rejects.toBeInstanceOf(
        ForbiddenError,
      )
      await expect(pcs().update(p1, mine.id, { account_id: p2Id })).rejects.toBeInstanceOf(
        ForbiddenError,
      )
      await expect(pcs().update(p1, mine.id, { account_id: null })).rejects.toBeInstanceOf(
        ForbiddenError,
      )
    })
  })

  it('the party list reads through the seam, so a player does not see a hidden PC', async () => {
    await withTestDatabase(async (pool) => {
      const db = createDb(pool)
      await migrateToLatest(db)
      const { dm, p1, p1Id, p2Id } = await setup(db)

      await pcs().create(dm, { name: 'Roland', account_id: p1Id })
      await pcs().create(dm, { name: 'The Ringer', account_id: p2Id, visibility: 'dm_only' })

      expect((await listParty(dm)).map((p) => p.name).sort()).toEqual(['Roland', 'The Ringer'])
      expect((await listParty(p1)).map((p) => p.name)).toEqual(['Roland'])
      // And a player asking for the hidden character's owner gets nothing,
      // rather than a name the DM withheld.
      expect(await findPcForAccount(p1, p2Id)).toBeUndefined()
    })
  })

  it('reports an unlinked PC as unlinked rather than omitting it', async () => {
    await withTestDatabase(async (pool) => {
      const db = createDb(pool)
      await migrateToLatest(db)
      const { dm } = await setup(db)

      await pcs().create(dm, { name: 'Unclaimed' })

      expect(await listParty(dm)).toEqual([
        { id: expect.any(String) as unknown as string, name: 'Unclaimed', accountId: null },
      ])
    })
  })
})
