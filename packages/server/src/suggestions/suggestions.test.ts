import type { Kysely } from 'kysely'
import { describe, expect, it } from 'vitest'
import { resolveWorldContext } from '../authz/context'
import { ForbiddenError } from '../authz/errors'
import type { WorldContext } from '../data/context'
import { createNpc, getNpc, softDeleteNpc } from '../data/npcs'
import { newId } from '../db/ids'
import { jsonb } from '../db/json'
import { createDb } from '../db/kysely'
import { migrateToLatest } from '../db/migrator'
import type { Database } from '../db/schema'
import { withTestDatabase } from '../db/test-database'
import { createTenancy } from '../tenancy'
import {
  acceptSuggestion,
  EmptySuggestionError,
  listSuggestions,
  proposeSuggestion,
  rejectSuggestion,
} from './suggestions'

async function makeAccount(db: Kysely<Database>, username: string): Promise<string> {
  const id = newId()
  await db.insertInto('accounts').values({ id, username, password_hash: 'h' }).execute()
  return id
}

async function setup(db: Kysely<Database>) {
  const tenancy = createTenancy(db)
  const dmId = await makeAccount(db, 'dm')
  const playerId = await makeAccount(db, 'player')
  const world = await tenancy.createWorldWithPlayer(dmId, 'W', playerId)
  const dm = (await resolveWorldContext(db, dmId, world.slug)) as WorldContext
  const player = (await resolveWorldContext(db, playerId, world.slug)) as WorldContext
  return { dm, player }
}

describe('suggestion queue', () => {
  it('gates proposals to entities the author can see', async () => {
    await withTestDatabase(async (pool) => {
      const db = createDb(pool)
      await migrateToLatest(db)
      const { dm, player } = await setup(db)
      const open = await createNpc(dm, { name: 'Mira', visibility: 'public' })
      const secret = await createNpc(dm, { name: 'The Prince', visibility: 'dm_only' })

      // visible entity → allowed
      const s = await proposeSuggestion(player, {
        targetKind: 'npc',
        targetId: open.id,
        proposed: { description: 'a fixer' },
      })
      expect(s.status).toBe('pending')

      // dm_only entity → invisible to the player → rejected
      await expect(
        proposeSuggestion(player, { targetKind: 'npc', targetId: secret.id, proposed: {} }),
      ).rejects.toBeInstanceOf(ForbiddenError)
      // unknown / non-suggestable kind → rejected
      await expect(
        proposeSuggestion(player, { targetKind: 'nonsense', targetId: open.id, proposed: {} }),
      ).rejects.toBeInstanceOf(ForbiddenError)
    })
  })

  it('DM accept applies a parameterized update but cannot touch protected fields', async () => {
    await withTestDatabase(async (pool) => {
      const db = createDb(pool)
      await migrateToLatest(db)
      const { dm, player } = await setup(db)
      const npc = await createNpc(dm, { name: 'Mira', visibility: 'public', description: 'old' })

      // the player tries to smuggle dm_only + a relocated id alongside a real edit
      const s = await proposeSuggestion(player, {
        targetKind: 'npc',
        targetId: npc.id,
        proposed: { description: 'player edit', visibility: 'dm_only', id: 'hijacked' },
      })

      // review list: DM sees it, player sees their own
      expect(await listSuggestions(dm)).toHaveLength(1)
      expect(await listSuggestions(player)).toHaveLength(1)
      // a player cannot accept
      await expect(acceptSuggestion(player, s.id)).rejects.toBeInstanceOf(ForbiddenError)

      const accepted = await acceptSuggestion(dm, s.id)
      expect(accepted?.status).toBe('accepted')

      const after = await getNpc(dm, npc.id)
      expect(after?.description).toBe('player edit') // the real edit applied
      expect(after?.visibility).toBe('public') // visibility NOT flipped
      expect(after?.id).toBe(npc.id) // id NOT relocated

      // queue is drained; re-accepting is a no-op
      expect(await listSuggestions(dm)).toHaveLength(0)
      expect(await acceptSuggestion(dm, s.id)).toBeUndefined()
    })
  })

  it('DM reject discards without touching canonical data', async () => {
    await withTestDatabase(async (pool) => {
      const db = createDb(pool)
      await migrateToLatest(db)
      const { dm, player } = await setup(db)
      const npc = await createNpc(dm, { name: 'Mira', visibility: 'public', description: 'keep' })
      const s = await proposeSuggestion(player, {
        targetKind: 'npc',
        targetId: npc.id,
        proposed: { description: 'nope' },
      })

      await expect(rejectSuggestion(player, s.id)).rejects.toBeInstanceOf(ForbiddenError)
      expect((await rejectSuggestion(dm, s.id))?.status).toBe('rejected')
      expect((await getNpc(dm, npc.id))?.description).toBe('keep') // unchanged
      expect(await rejectSuggestion(dm, s.id)).toBeUndefined() // already resolved
      expect(await listSuggestions(dm)).toHaveLength(0)
    })
  })

  it('refuses to accept a suggestion whose target is missing or deleted', async () => {
    await withTestDatabase(async (pool) => {
      const db = createDb(pool)
      await migrateToLatest(db)
      const { dm, player } = await setup(db)

      // (a) a suggestion with no target at all (target_entity_id → SET NULL)
      const nullTarget = newId()
      await db
        .insertInto('suggestions')
        .values({
          world_id: dm.worldId,
          author_id: dm.actor.accountId,
          proposed: jsonb({}),
          id: nullTarget,
          target_entity_id: null,
        })
        .execute()

      // (b) a suggestion whose target entity has since been soft-deleted (the kind
      // is derived from the live entities row, so a dead target resolves to none)
      const npc = await createNpc(dm, { name: 'Doomed', visibility: 'public' })
      // Non-empty on purpose: this test's subject is the DEAD TARGET, and an
      // empty proposal is now refused at propose time (bug 1180), which would
      // have this failing for the wrong reason.
      const s = await proposeSuggestion(player, {
        targetKind: 'npc',
        targetId: npc.id,
        proposed: { description: 'about to be orphaned' },
      })
      await softDeleteNpc(dm, npc.id)

      await expect(acceptSuggestion(dm, nullTarget)).rejects.toBeInstanceOf(ForbiddenError)
      await expect(acceptSuggestion(dm, s.id)).rejects.toBeInstanceOf(ForbiddenError)
    })
  })
})

/** A world with one NPC that has a populated description worth protecting. */
async function richNpc(pool: Parameters<Parameters<typeof withTestDatabase>[0]>[0]) {
  const db = createDb(pool)
  await migrateToLatest(db)
  const { dm, player } = await setup(db)
  const npc = await createNpc(dm, {
    name: 'Rich NPC',
    description: 'A long, carefully written backstory.',
    visibility: 'public',
  })
  return { db, dm, player, npc }
}

/**
 * Bug 1180: an accepted suggestion must never blank a populated field.
 *
 * The peer-dev report this came from lost a fully-statted character to the same
 * shape — a merge that kept the emptier record. Here the vector is the propose
 * form, which sends every field it renders, so a player editing one field
 * submits blanks for the others.
 */
describe('accepting a suggestion cannot blank populated fields (bug 1180)', () => {
  it('drops an empty proposed value instead of erasing the existing one', async () => {
    await withTestDatabase(async (pool) => {
      const { dm, player, npc } = await richNpc(pool)

      const sug = await proposeSuggestion(player, {
        targetKind: 'npc',
        targetId: npc.id,
        // one real edit, one blank the form sent along with it
        proposed: { name: 'Renamed', description: '   ' },
      })
      await acceptSuggestion(dm, sug.id)

      const after = await getNpc(dm, npc.id)
      expect(after?.name).toBe('Renamed')
      expect(after?.description).toBe('A long, carefully written backstory.')
    })
  })

  it('refuses a proposal that carries nothing to apply', async () => {
    await withTestDatabase(async (pool) => {
      const { player, npc } = await richNpc(pool)

      await expect(
        proposeSuggestion(player, {
          targetKind: 'npc',
          targetId: npc.id,
          proposed: { description: '', name: null },
        }),
      ).rejects.toBeInstanceOf(EmptySuggestionError)
    })
  })

  it('keeps falsy-but-real values — false and 0 are content, not blanks', async () => {
    await withTestDatabase(async (pool) => {
      const { player, npc } = await richNpc(pool)
      // proposed through the same path; the guard must not mistake 0 for empty
      const sug = await proposeSuggestion(player, {
        targetKind: 'npc',
        targetId: npc.id,
        proposed: { description: 'still content', age: 0 },
      })
      expect((sug.proposed as Record<string, unknown>).age).toBe(0)
    })
  })
})
