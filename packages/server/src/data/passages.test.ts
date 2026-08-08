import type { Kysely } from 'kysely'
import { describe, expect, it } from 'vitest'
import type { ContentTableName } from '../authz/content'
import { ForbiddenError } from '../authz/errors'
import { resolveWorldContext } from '../authz/context'
import { deleteAccount } from '../auth/deletion'
import { newId } from '../db/ids'
import { createDb } from '../db/kysely'
import { migrateToLatest } from '../db/migrator'
import type { Database } from '../db/schema'
import { withTestDatabase } from '../db/test-database'
import { createTenancy } from '../tenancy'
import {
  DEFAULT_LIMITS,
  assertCanCreatePassage,
  assertPassageBodyWithinLimit,
  LimitReachedError,
} from '../tenancy/limits'
import { exportWorld } from '../world-io'
import { changeEntityKind } from './change-kind'
import type { WorldContext } from './context'
import { CONTENT_REPOS } from './content-repos'
import {
  composeForEntities,
  composeForEntity,
  createPassage,
  deletePassage,
  getPassage,
  grantPassageVisibility,
  listPassageGrants,
  listPassagesForEntities,
  listPassagesForEntity,
  revokePassageVisibility,
  updatePassage,
} from './passages'

async function makeAccount(db: Kysely<Database>, username: string): Promise<string> {
  const id = newId()
  await db.insertInto('accounts').values({ id, username, password_hash: 'h' }).execute()
  return id
}

/** A world with an owner, a player, and an NPC whose description is public. */
async function setup(db: Kysely<Database>, prefix: string) {
  const tenancy = createTenancy(db)
  const ownerId = await makeAccount(db, `${prefix}-dm`)
  const playerId = await makeAccount(db, `${prefix}-player`)
  const world = await tenancy.createWorldWithPlayer(ownerId, prefix, playerId)
  const ownerCtx = (await resolveWorldContext(db, ownerId, world.slug)) as WorldContext
  const playerCtx = (await resolveWorldContext(db, playerId, world.slug)) as WorldContext
  const npc = (await CONTENT_REPOS.npc!.create(ownerCtx, {
    name: 'Silas Crow',
    description: 'A fishmonger with ink-stained cuffs.',
    visibility: 'public',
  })) as unknown as { id: string; description: string }
  return { world, ownerId, playerId, ownerCtx, playerCtx, npc }
}

/** Add a second player to an existing world. */
async function addPlayer(db: Kysely<Database>, w: Awaited<ReturnType<typeof setup>>, name: string) {
  const tenancy = createTenancy(db)
  const id = await makeAccount(db, name)
  await tenancy.grantMember(w.ownerId, w.world.id, id)
  const ctx = (await resolveWorldContext(db, id, w.world.slug)) as WorldContext
  return { id, ctx }
}

describe('passages — the seam does the filtering', () => {
  /**
   * The assignment is the assertion, and it is a COMPILE-time one. Carrying
   * id/world_id/visibility/deleted_at is what `ContentTableName` tests for, and
   * satisfying it is what gets passages world-scoping, soft-delete hiding, the
   * 3-state filter and owner-only writes without a line of authorization code.
   * If a future migration drops one of those columns, this stops compiling —
   * the guarantee lives in the type rather than in a comment.
   */
  it('is a content table by structure, which is what earns it the seam', () => {
    const table: ContentTableName = 'entity_passages'
    expect(table).toBe('entity_passages')
  })

  it('defaults to dm_only, so an unspecified visibility is never readable by a player', async () => {
    await withTestDatabase(async (pool) => {
      const db = createDb(pool)
      await migrateToLatest(db)
      const w = await setup(db, 'p1')

      const p = await createPassage(
        w.ownerCtx,
        { entityId: w.npc.id, body: 'He keeps the ledger.' },
        w.ownerId,
      )
      expect(p.visibility).toBe('dm_only')

      expect(await listPassagesForEntity(w.ownerCtx, w.npc.id)).toHaveLength(1)
      expect(await listPassagesForEntity(w.playerCtx, w.npc.id)).toHaveLength(0)
    })
  })

  it('composes base description + authorized passages, and nothing else', async () => {
    await withTestDatabase(async (pool) => {
      const db = createDb(pool)
      await migrateToLatest(db)
      const w = await setup(db, 'p2')

      await createPassage(
        w.ownerCtx,
        { entityId: w.npc.id, body: 'Everyone knows he sells eels.', visibility: 'public' },
        w.ownerId,
      )
      await createPassage(
        w.ownerCtx,
        { entityId: w.npc.id, body: 'He keeps the Ashen Hand ledger.', visibility: 'dm_only' },
        w.ownerId,
      )

      const asOwner = await composeForEntity(w.ownerCtx, w.npc)
      expect(asOwner).toContain('ink-stained cuffs')
      expect(asOwner).toContain('sells eels')
      expect(asOwner).toContain('Ashen Hand ledger')

      const asPlayer = await composeForEntity(w.playerCtx, w.npc)
      expect(asPlayer).toContain('ink-stained cuffs')
      expect(asPlayer).toContain('sells eels')
      expect(asPlayer).not.toContain('Ashen Hand ledger')
    })
  })

  it('a restricted passage follows its own grant: hidden, granted, revoked', async () => {
    await withTestDatabase(async (pool) => {
      const db = createDb(pool)
      await migrateToLatest(db)
      const w = await setup(db, 'p3')

      const p = await createPassage(
        w.ownerCtx,
        { entityId: w.npc.id, body: 'He owes YOU a favour.', visibility: 'restricted' },
        w.ownerId,
      )

      expect(await composeForEntity(w.playerCtx, w.npc)).not.toContain('favour')

      await grantPassageVisibility(w.ownerCtx, p.id, w.playerId)
      expect(await composeForEntity(w.playerCtx, w.npc)).toContain('favour')
      expect(await listPassageGrants(w.ownerCtx, p.id)).toEqual([w.playerId])

      await revokePassageVisibility(w.ownerCtx, p.id, w.playerId)
      expect(await composeForEntity(w.playerCtx, w.npc)).not.toContain('favour')
    })
  })

  it('a grant on one passage never admits another, and never reaches a second player', async () => {
    await withTestDatabase(async (pool) => {
      const db = createDb(pool)
      await migrateToLatest(db)
      const w = await setup(db, 'p4')
      const second = await addPlayer(db, w, 'p4-player2')

      const granted = await createPassage(
        w.ownerCtx,
        { entityId: w.npc.id, body: 'GRANTED SECRET', visibility: 'restricted' },
        w.ownerId,
      )
      await createPassage(
        w.ownerCtx,
        { entityId: w.npc.id, body: 'SIBLING SECRET', visibility: 'restricted' },
        w.ownerId,
      )
      await grantPassageVisibility(w.ownerCtx, granted.id, w.playerId)

      const one = await composeForEntity(w.playerCtx, w.npc)
      expect(one).toContain('GRANTED SECRET')
      expect(one).not.toContain('SIBLING SECRET')

      const two = await composeForEntity(second.ctx, w.npc)
      expect(two).not.toContain('GRANTED SECRET')
      expect(two).not.toContain('SIBLING SECRET')
    })
  })

  it('a soft-deleted passage never composes again', async () => {
    await withTestDatabase(async (pool) => {
      const db = createDb(pool)
      await migrateToLatest(db)
      const w = await setup(db, 'p5')

      const p = await createPassage(
        w.ownerCtx,
        { entityId: w.npc.id, body: 'RETRACTED', visibility: 'public' },
        w.ownerId,
      )
      expect(await composeForEntity(w.ownerCtx, w.npc)).toContain('RETRACTED')

      expect(await deletePassage(w.ownerCtx, p.id)).toBe(true)
      expect(await composeForEntity(w.ownerCtx, w.npc)).not.toContain('RETRACTED')
      expect(await composeForEntity(w.playerCtx, w.npc)).not.toContain('RETRACTED')
    })
  })

  it('renders in position order, with ties broken by creation time', async () => {
    await withTestDatabase(async (pool) => {
      const db = createDb(pool)
      await migrateToLatest(db)
      const w = await setup(db, 'p6')
      const add = (body: string, position: number) =>
        createPassage(
          w.ownerCtx,
          { entityId: w.npc.id, body, position, visibility: 'public' },
          w.ownerId,
        )

      await add('THIRD', 2)
      await add('FIRST', 0)
      await add('SECOND-A', 1)
      await add('SECOND-B', 1)

      const text = await composeForEntity(w.ownerCtx, w.npc)
      const order = ['FIRST', 'SECOND-A', 'SECOND-B', 'THIRD'].map((s) => text.indexOf(s))
      expect(order).toEqual([...order].sort((a, b) => a - b))
      expect(order.every((i) => i >= 0)).toBe(true)
    })
  })

  it('a player cannot create, edit, delete, grant, revoke, or list grants', async () => {
    await withTestDatabase(async (pool) => {
      const db = createDb(pool)
      await migrateToLatest(db)
      const w = await setup(db, 'p7')
      const p = await createPassage(
        w.ownerCtx,
        { entityId: w.npc.id, body: 'X', visibility: 'public' },
        w.ownerId,
      )

      await expect(
        createPassage(w.playerCtx, { entityId: w.npc.id, body: 'Y' }, w.playerId),
      ).rejects.toBeInstanceOf(ForbiddenError)
      await expect(updatePassage(w.playerCtx, p.id, { body: 'Z' })).rejects.toBeInstanceOf(
        ForbiddenError,
      )
      await expect(deletePassage(w.playerCtx, p.id)).rejects.toBeInstanceOf(ForbiddenError)
      await expect(grantPassageVisibility(w.playerCtx, p.id, w.playerId)).rejects.toBeInstanceOf(
        ForbiddenError,
      )
      await expect(revokePassageVisibility(w.playerCtx, p.id, w.playerId)).rejects.toBeInstanceOf(
        ForbiddenError,
      )
      await expect(listPassageGrants(w.playerCtx, p.id)).rejects.toBeInstanceOf(ForbiddenError)
    })
  })
})

describe('passages — editing and reading one at a time', () => {
  it('patches only the fields supplied, and leaves the rest alone', async () => {
    await withTestDatabase(async (pool) => {
      const db = createDb(pool)
      await migrateToLatest(db)
      const w = await setup(db, 'p13')

      const p = await createPassage(
        w.ownerCtx,
        { entityId: w.npc.id, body: 'first draft', position: 3, visibility: 'public' },
        w.ownerId,
      )

      // one field at a time — each spread in the patch builder gets exercised
      const bodyOnly = await updatePassage(w.ownerCtx, p.id, { body: 'second draft' })
      expect(bodyOnly).toMatchObject({ body: 'second draft', position: 3, visibility: 'public' })

      const positionOnly = await updatePassage(w.ownerCtx, p.id, { position: 7 })
      expect(positionOnly).toMatchObject({ body: 'second draft', position: 7 })

      const visibilityOnly = await updatePassage(w.ownerCtx, p.id, { visibility: 'dm_only' })
      expect(visibilityOnly).toMatchObject({ position: 7, visibility: 'dm_only' })

      // and an empty patch is a no-op rather than a wipe
      expect(await updatePassage(w.ownerCtx, p.id, {})).toMatchObject({
        body: 'second draft',
        position: 7,
        visibility: 'dm_only',
      })
    })
  })

  it('returns undefined for a passage this actor cannot reach', async () => {
    await withTestDatabase(async (pool) => {
      const db = createDb(pool)
      await migrateToLatest(db)
      const w = await setup(db, 'p14')
      const secret = await createPassage(
        w.ownerCtx,
        { entityId: w.npc.id, body: 'hidden', visibility: 'dm_only' },
        w.ownerId,
      )

      expect(await getPassage(w.ownerCtx, secret.id)).toMatchObject({ body: 'hidden' })
      expect(await getPassage(w.playerCtx, secret.id)).toBeUndefined()
      expect(await getPassage(w.ownerCtx, 'no-such-passage')).toBeUndefined()
      expect(await updatePassage(w.ownerCtx, 'no-such-passage', { body: 'x' })).toBeUndefined()
      expect(await deletePassage(w.ownerCtx, 'no-such-passage')).toBe(false)
    })
  })

  it('composes many entities in one pass, each scoped to the same viewer', async () => {
    await withTestDatabase(async (pool) => {
      const db = createDb(pool)
      await migrateToLatest(db)
      const w = await setup(db, 'p16')

      const second = (await CONTENT_REPOS.npc!.create(w.ownerCtx, {
        name: 'Mira Vance',
        description: 'Keeps the lighthouse.',
        visibility: 'public',
      })) as unknown as { id: string; description: string }

      await createPassage(
        w.ownerCtx,
        { entityId: w.npc.id, body: 'CROW SECRET', visibility: 'dm_only' },
        w.ownerId,
      )
      await createPassage(
        w.ownerCtx,
        { entityId: second.id, body: 'MIRA OPEN', visibility: 'public' },
        w.ownerId,
      )

      // This is the shape a list page uses: N entities, one batched read, each
      // entity's prose composed for the SAME actor.
      const asPlayer = await composeForEntities(w.playerCtx, [w.npc, second])
      expect(asPlayer.get(w.npc.id)).not.toContain('CROW SECRET')
      expect(asPlayer.get(second.id)).toContain('MIRA OPEN')

      const asOwner = await composeForEntities(w.ownerCtx, [w.npc, second])
      expect(asOwner.get(w.npc.id)).toContain('CROW SECRET')
      expect(asOwner.get(second.id)).toContain('MIRA OPEN')

      // and the batch and single-entity doors agree, so a list page and a detail
      // page can never show a viewer different text
      expect(asPlayer.get(w.npc.id)).toBe(await composeForEntity(w.playerCtx, w.npc))
    })
  })

  it('composes an entity that has no passages as just its description', async () => {
    await withTestDatabase(async (pool) => {
      const db = createDb(pool)
      await migrateToLatest(db)
      const w = await setup(db, 'p15')

      expect(await composeForEntity(w.ownerCtx, w.npc)).toBe(w.npc.description)
      expect(await listPassagesForEntities(w.ownerCtx, [])).toEqual(new Map())

      // an entity with no description composes to its passages alone, with no
      // leading blank line
      const blank = (await CONTENT_REPOS.npc!.create(w.ownerCtx, {
        name: 'Nameless',
      })) as unknown as { id: string; description: string }
      await createPassage(
        w.ownerCtx,
        { entityId: blank.id, body: 'ONLY THIS', visibility: 'public' },
        w.ownerId,
      )
      expect(await composeForEntity(w.ownerCtx, blank)).toBe('ONLY THIS')
    })
  })
})

describe('passages — a passage never outranks its parent', () => {
  it('a public passage on a dm_only entity stays unreachable for a player', async () => {
    await withTestDatabase(async (pool) => {
      const db = createDb(pool)
      await migrateToLatest(db)
      const w = await setup(db, 'p8')

      // the entity itself is the DM's secret
      const secret = (await CONTENT_REPOS.npc!.create(w.ownerCtx, {
        name: 'The Hollow Man',
        description: 'Nobody has seen his face.',
        visibility: 'dm_only',
      })) as unknown as { id: string; description: string }
      await createPassage(
        w.ownerCtx,
        { entityId: secret.id, body: 'PUBLIC ON A SECRET', visibility: 'public' },
        w.ownerId,
      )

      // The seam filters a passage by its OWN visibility, so this public row is
      // visible in isolation — the invariant holds because there is no door to
      // it except through the parent, which the player cannot open.
      expect(await CONTENT_REPOS.npc!.get(w.playerCtx, secret.id)).toBeUndefined()

      // and the passage is not reachable on any entity the player CAN see
      expect(await composeForEntity(w.playerCtx, w.npc)).not.toContain('PUBLIC ON A SECRET')
    })
  })
})

describe('passages — interaction with the rest of the schema', () => {
  it('survives a kind change, because it hangs off the entity id and not the kind', async () => {
    await withTestDatabase(async (pool) => {
      const db = createDb(pool)
      await migrateToLatest(db)
      const w = await setup(db, 'p9')
      await createPassage(
        w.ownerCtx,
        { entityId: w.npc.id, body: 'STILL HERE', visibility: 'public' },
        w.ownerId,
      )

      await changeEntityKind(w.ownerCtx, w.npc.id, 'pc')

      const after = await listPassagesForEntity(w.ownerCtx, w.npc.id)
      expect(after).toHaveLength(1)
      expect(after[0]?.body).toBe('STILL HERE')
    })
  })

  it('deleting the author forgets who wrote it but keeps the prose', async () => {
    await withTestDatabase(async (pool) => {
      const db = createDb(pool)
      await migrateToLatest(db)
      const w = await setup(db, 'p10')
      const helper = await addPlayer(db, w, 'p10-scribe')

      const p = await createPassage(
        w.ownerCtx,
        { entityId: w.npc.id, body: 'WRITTEN BY SOMEONE', visibility: 'restricted' },
        helper.id,
      )
      await grantPassageVisibility(w.ownerCtx, p.id, helper.id)

      await deleteAccount(db, helper.id)

      const after = await listPassagesForEntity(w.ownerCtx, w.npc.id)
      expect(after).toHaveLength(1)
      expect(after[0]?.body).toBe('WRITTEN BY SOMEONE')
      expect(after[0]?.author_id).toBeNull()

      // the grant went with the account — it is meaningless without it
      expect(await listPassageGrants(w.ownerCtx, p.id)).toEqual([])
    })
  })

  it('round-trips through a world export', async () => {
    await withTestDatabase(async (pool) => {
      const db = createDb(pool)
      await migrateToLatest(db)
      const w = await setup(db, 'p11')
      await createPassage(
        w.ownerCtx,
        { entityId: w.npc.id, body: 'EXPORTED REVEAL', visibility: 'dm_only' },
        w.ownerId,
      )

      const dump = await exportWorld(w.ownerCtx)
      const rows = dump.tables.entity_passages as ReadonlyArray<Record<string, unknown>>
      expect(rows).toHaveLength(1)
      expect(rows[0]?.body).toBe('EXPORTED REVEAL')

      // the ACL is account-coupled and deliberately absent, like entity_visibility
      expect(dump.tables.passage_visibility).toBeUndefined()
      expect(dump.tables.entity_visibility).toBeUndefined()
    })
  })
})

describe('passages — resource ceilings', () => {
  it('refuses a body over the character limit', () => {
    const tooLong = 'x'.repeat(DEFAULT_LIMITS.passageBodyChars + 1)
    expect(() => assertPassageBodyWithinLimit(tooLong, DEFAULT_LIMITS)).toThrow(LimitReachedError)
    expect(() =>
      assertPassageBodyWithinLimit('x'.repeat(DEFAULT_LIMITS.passageBodyChars), DEFAULT_LIMITS),
    ).not.toThrow()
  })

  it('refuses a new passage once the entity is at its ceiling', async () => {
    await withTestDatabase(async (pool) => {
      const db = createDb(pool)
      await migrateToLatest(db)
      const w = await setup(db, 'p12')
      const limits = { ...DEFAULT_LIMITS, passagesPerEntity: 2 }

      await assertCanCreatePassage(db, w.world.id, w.npc.id, limits)
      await createPassage(w.ownerCtx, { entityId: w.npc.id, body: 'one' }, w.ownerId)
      await createPassage(w.ownerCtx, { entityId: w.npc.id, body: 'two' }, w.ownerId)

      await expect(assertCanCreatePassage(db, w.world.id, w.npc.id, limits)).rejects.toBeInstanceOf(
        LimitReachedError,
      )

      // the ceiling is per entity, not per world
      const other = (await CONTENT_REPOS.npc!.create(w.ownerCtx, {
        name: 'Someone Else',
      })) as unknown as { id: string }
      await assertCanCreatePassage(db, w.world.id, other.id, limits)
    })
  })
})
