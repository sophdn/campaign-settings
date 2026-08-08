import { type Kysely, sql } from 'kysely'
import { describe, expect, it } from 'vitest'
import type { WorldContext } from '../data/context'
import { type ContentTableName, createContentRepository } from './content'
import { CONTENT_REPOS } from '../data/content-repos'
import { createNpc, getNpc, listNpcs, softDeleteNpc, updateNpc } from '../data/npcs'
import { newId } from '../db/ids'
import { createDb } from '../db/kysely'
import { migrateToLatest } from '../db/migrator'
import type { Database } from '../db/schema'
import { withTestDatabase } from '../db/test-database'
import {
  grantEntityVisibility,
  listEntityGrants,
  revokeEntityVisibility,
} from '../data/entity-visibility'
import { createTenancy } from '../tenancy'
import { resolveWorldContext } from './context'
import { ForbiddenError } from './errors'

async function makeAccount(db: Kysely<Database>, username: string): Promise<string> {
  const id = newId()
  await db.insertInto('accounts').values({ id, username, password_hash: 'h' }).execute()
  return id
}

/** A world owned by `<prefix>-dm` with `<prefix>-player` granted, plus both contexts. */
async function setupWorld(db: Kysely<Database>, prefix: string) {
  const tenancy = createTenancy(db)
  const ownerId = await makeAccount(db, `${prefix}-dm`)
  const playerId = await makeAccount(db, `${prefix}-player`)
  const world = await tenancy.createWorldWithPlayer(ownerId, prefix, playerId)
  const ownerCtx = (await resolveWorldContext(db, ownerId, world.slug)) as WorldContext
  const playerCtx = (await resolveWorldContext(db, playerId, world.slug)) as WorldContext
  return { world, ownerCtx, playerCtx }
}

describe('content authorization seam (via npcs)', () => {
  it('owner sees every row; a player sees only non-secret rows', async () => {
    await withTestDatabase(async (pool) => {
      const db = createDb(pool)
      await migrateToLatest(db)
      const { ownerCtx, playerCtx } = await setupWorld(db, 'w')

      const secret = await createNpc(ownerCtx, { name: 'The Prince', visibility: 'dm_only' })
      const open = await createNpc(ownerCtx, { name: 'A Ghoul', visibility: 'public' })

      // owner: full visibility
      expect(await getNpc(ownerCtx, secret.id)).toMatchObject({ name: 'The Prince' })
      expect(await listNpcs(ownerCtx)).toHaveLength(2)

      // player: secrets are invisible through every read door
      expect(await getNpc(playerCtx, secret.id)).toBeUndefined()
      expect(await getNpc(playerCtx, open.id)).toMatchObject({ name: 'A Ghoul' })
      expect(await listNpcs(playerCtx)).toHaveLength(1)
    })
  })

  it('a player cannot create, update, or delete content through any door', async () => {
    await withTestDatabase(async (pool) => {
      const db = createDb(pool)
      await migrateToLatest(db)
      const { ownerCtx, playerCtx } = await setupWorld(db, 'w')
      const npc = await createNpc(ownerCtx, { name: 'X', visibility: 'public' })

      await expect(createNpc(playerCtx, { name: 'Y' })).rejects.toBeInstanceOf(ForbiddenError)
      await expect(updateNpc(playerCtx, npc.id, { name: 'Z' })).rejects.toBeInstanceOf(
        ForbiddenError,
      )
      await expect(softDeleteNpc(playerCtx, npc.id)).rejects.toBeInstanceOf(ForbiddenError)

      // nothing the player attempted took effect
      expect((await getNpc(ownerCtx, npc.id))?.name).toBe('X')
    })
  })

  it('soft-deleted rows are hidden and re-deletion is a no-op', async () => {
    await withTestDatabase(async (pool) => {
      const db = createDb(pool)
      await migrateToLatest(db)
      const { ownerCtx } = await setupWorld(db, 'w')
      const npc = await createNpc(ownerCtx, { name: 'X' })

      expect(await softDeleteNpc(ownerCtx, npc.id)).toBe(true)
      expect(await getNpc(ownerCtx, npc.id)).toBeUndefined()
      expect(await listNpcs(ownerCtx)).toHaveLength(0)
      expect(await softDeleteNpc(ownerCtx, npc.id)).toBe(false)
    })
  })

  it('one world cannot read or mutate another world’s rows (tenancy wall)', async () => {
    await withTestDatabase(async (pool) => {
      const db = createDb(pool)
      await migrateToLatest(db)
      const a = await setupWorld(db, 'a')
      const b = await setupWorld(db, 'b')

      const aNpc = await createNpc(
        a.ownerCtx,
        { name: 'A-secret', visibility: 'dm_only' },
        'fixed-a',
      )

      // B's owner is blind to A's row through every door
      expect(await getNpc(b.ownerCtx, aNpc.id)).toBeUndefined()
      expect(await updateNpc(b.ownerCtx, aNpc.id, { name: 'hijack' })).toBeUndefined()
      expect(await softDeleteNpc(b.ownerCtx, aNpc.id)).toBe(false)
      expect(await listNpcs(b.ownerCtx)).toHaveLength(0)

      // A's owner can still operate normally
      expect((await getNpc(a.ownerCtx, aNpc.id))?.name).toBe('A-secret')
      const renamed = await updateNpc(a.ownerCtx, aNpc.id, { name: 'A-renamed' })
      expect(renamed?.name).toBe('A-renamed')
    })
  })
})

describe('per-player visibility — the 3-state model + grant ACL', () => {
  it('a restricted row is hidden from an ungranted player, shown once granted, hidden after revoke', async () => {
    await withTestDatabase(async (pool) => {
      const db = createDb(pool)
      await migrateToLatest(db)
      const { ownerCtx, playerCtx } = await setupWorld(db, 'w')
      const playerId = playerCtx.actor.accountId

      const r = await createNpc(ownerCtx, { name: 'Hidden Cabal', visibility: 'restricted' })

      // owner always sees it; ungranted player sees nothing through any door
      expect(await getNpc(ownerCtx, r.id)).toMatchObject({ name: 'Hidden Cabal' })
      expect(await getNpc(playerCtx, r.id)).toBeUndefined()
      expect(await listNpcs(playerCtx)).toHaveLength(0)

      // grant → visible through get + list
      await grantEntityVisibility(ownerCtx, r.id, playerId)
      expect(await getNpc(playerCtx, r.id)).toMatchObject({ name: 'Hidden Cabal' })
      expect(await listNpcs(playerCtx)).toHaveLength(1)
      expect(await listEntityGrants(ownerCtx, r.id)).toEqual([playerId])

      // revoke → hidden again
      await revokeEntityVisibility(ownerCtx, r.id, playerId)
      expect(await getNpc(playerCtx, r.id)).toBeUndefined()
      expect(await listNpcs(playerCtx)).toHaveLength(0)
    })
  })

  it('a grant for one player never leaks the row to a different player', async () => {
    await withTestDatabase(async (pool) => {
      const db = createDb(pool)
      await migrateToLatest(db)
      const tenancy = createTenancy(db)
      const { world, ownerCtx, playerCtx } = await setupWorld(db, 'w')
      const player2Id = await makeAccount(db, 'w-player2')
      await tenancy.grantMember(ownerCtx.actor.accountId, world.id, player2Id)
      const player2Ctx = (await resolveWorldContext(db, player2Id, world.slug)) as WorldContext

      const r = await createNpc(ownerCtx, { name: 'For Player One', visibility: 'restricted' })
      await grantEntityVisibility(ownerCtx, r.id, playerCtx.actor.accountId)

      expect(await getNpc(playerCtx, r.id)).toMatchObject({ name: 'For Player One' })
      expect(await getNpc(player2Ctx, r.id)).toBeUndefined()
      expect(await listNpcs(player2Ctx)).toHaveLength(0)
    })
  })

  it('a grant does not override dm_only — that stays owner-only', async () => {
    await withTestDatabase(async (pool) => {
      const db = createDb(pool)
      await migrateToLatest(db)
      const { ownerCtx, playerCtx } = await setupWorld(db, 'w')

      const secret = await createNpc(ownerCtx, { name: 'DM Secret', visibility: 'dm_only' })
      // even if a stray grant exists, a dm_only row is never shown to a player
      await grantEntityVisibility(ownerCtx, secret.id, playerCtx.actor.accountId)

      expect(await getNpc(playerCtx, secret.id)).toBeUndefined()
      expect(await listNpcs(playerCtx)).toHaveLength(0)
    })
  })

  it('a grant is specific to its entity — it does not expose other restricted rows', async () => {
    await withTestDatabase(async (pool) => {
      const db = createDb(pool)
      await migrateToLatest(db)
      const { ownerCtx, playerCtx } = await setupWorld(db, 'w')

      const granted = await createNpc(ownerCtx, { name: 'Granted', visibility: 'restricted' })
      const other = await createNpc(ownerCtx, { name: 'Other', visibility: 'restricted' })
      await grantEntityVisibility(ownerCtx, granted.id, playerCtx.actor.accountId)

      // the grant exposes ONLY its entity; the sibling restricted row stays hidden
      expect(await getNpc(playerCtx, granted.id)).toMatchObject({ name: 'Granted' })
      expect(await getNpc(playerCtx, other.id)).toBeUndefined()
      expect(await listNpcs(playerCtx)).toHaveLength(1)
    })
  })

  it('a player cannot grant, revoke, or list grants (owner-only)', async () => {
    await withTestDatabase(async (pool) => {
      const db = createDb(pool)
      await migrateToLatest(db)
      const { ownerCtx, playerCtx } = await setupWorld(db, 'w')
      const r = await createNpc(ownerCtx, { name: 'R', visibility: 'restricted' })
      const target = playerCtx.actor.accountId

      await expect(grantEntityVisibility(playerCtx, r.id, target)).rejects.toBeInstanceOf(
        ForbiddenError,
      )
      await expect(revokeEntityVisibility(playerCtx, r.id, target)).rejects.toBeInstanceOf(
        ForbiddenError,
      )
      await expect(listEntityGrants(playerCtx, r.id)).rejects.toBeInstanceOf(ForbiddenError)
    })
  })
})

/**
 * The seam's grant lookup is a PARAMETER, not a constant. These tests prove it
 * against a table that does not exist in production: `trinkets`, with its own
 * ACL `trinket_visibility`. If the exists-subquery were still hard-coded to
 * `entity_visibility` every one of them would fail, because a trinket's id is
 * not an entity id and no `entity_visibility` row will ever name one.
 *
 * The fixture is created per-test rather than by a migration on purpose — this
 * capability needs no production schema change, and adding a real table just to
 * test it would ship dead weight. The second REAL consumer is `entity_passages`
 * (chain 453 task 2); maps are the third (suggestion 71).
 */
const TRINKET_GRANTS = { table: 'trinket_visibility', subjectColumn: 'trinket_id' } as const

/** The fixture repo's surface, loosely typed — `trinkets` is not in `Database`. */
interface LooseRepo {
  create(ctx: WorldContext, input: Record<string, unknown>): Promise<Record<string, unknown>>
  get(ctx: WorldContext, id: string): Promise<Record<string, unknown> | undefined>
  list(ctx: WorldContext): Promise<Record<string, unknown>[]>
  listByParents(ctx: WorldContext, parentIds: readonly string[]): Promise<Record<string, unknown>[]>
}

const trinkets = createContentRepository('trinkets' as unknown as ContentTableName, {
  grantTable: TRINKET_GRANTS,
}) as unknown as LooseRepo

/** A content table + its own ACL, shaped so `ContentTableName` would admit it. */
async function createTrinketFixture(db: Kysely<Database>): Promise<void> {
  await db.schema
    .createTable('trinkets')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('world_id', 'text', (c) => c.notNull().references('worlds.id').onDelete('cascade'))
    .addColumn('name', 'text', (c) => c.notNull().defaultTo(''))
    .addColumn('visibility', 'text', (c) => c.notNull().defaultTo('dm_only'))
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn('deleted_at', 'timestamptz')
    .execute()
  await db.schema
    .createTable('trinket_visibility')
    .addColumn('world_id', 'text', (c) => c.notNull().references('worlds.id').onDelete('cascade'))
    .addColumn('trinket_id', 'text', (c) =>
      c.notNull().references('trinkets.id').onDelete('cascade'),
    )
    .addColumn('account_id', 'text', (c) =>
      c.notNull().references('accounts.id').onDelete('cascade'),
    )
    .addPrimaryKeyConstraint('trinket_visibility_pkey', ['trinket_id', 'account_id'])
    .execute()
}

/** Insert a grant directly — this task adds no production grant helper. */
async function grantTrinket(
  db: Kysely<Database>,
  worldId: string,
  trinketId: string,
  accountId: string,
): Promise<void> {
  await (db as unknown as Kysely<Record<string, Record<string, unknown>>>)
    .insertInto('trinket_visibility')
    .values({ world_id: worldId, trinket_id: trinketId, account_id: accountId })
    .execute()
}

describe('the grant ACL is a parameter — a non-entities table with its own ACL', () => {
  it('hides a restricted row from an ungranted player and shows it once granted', async () => {
    await withTestDatabase(async (pool) => {
      const db = createDb(pool)
      await migrateToLatest(db)
      await createTrinketFixture(db)
      const { ownerCtx, playerCtx } = await setupWorld(db, 't1')

      const r = await trinkets.create(ownerCtx, { name: 'Sealed Locket', visibility: 'restricted' })
      const id = r.id as string

      // owner always; ungranted player never — through get AND list
      expect(await trinkets.get(ownerCtx, id)).toMatchObject({ name: 'Sealed Locket' })
      expect(await trinkets.get(playerCtx, id)).toBeUndefined()
      expect(await trinkets.list(playerCtx)).toHaveLength(0)

      await grantTrinket(db, ownerCtx.worldId, id, playerCtx.actor.accountId)

      expect(await trinkets.get(playerCtx, id)).toMatchObject({ name: 'Sealed Locket' })
      expect(await trinkets.list(playerCtx)).toHaveLength(1)
    })
  })

  it('a grant for one account never admits a different account', async () => {
    await withTestDatabase(async (pool) => {
      const db = createDb(pool)
      await migrateToLatest(db)
      await createTrinketFixture(db)
      const tenancy = createTenancy(db)
      const { world, ownerCtx, playerCtx } = await setupWorld(db, 't2')
      const player2Id = await makeAccount(db, 't2-player2')
      await tenancy.grantMember(ownerCtx.actor.accountId, world.id, player2Id)
      const player2Ctx = (await resolveWorldContext(db, player2Id, world.slug)) as WorldContext

      const r = await trinkets.create(ownerCtx, { name: 'For One', visibility: 'restricted' })
      await grantTrinket(db, world.id, r.id as string, playerCtx.actor.accountId)

      expect(await trinkets.get(playerCtx, r.id as string)).toMatchObject({ name: 'For One' })
      expect(await trinkets.get(player2Ctx, r.id as string)).toBeUndefined()
      expect(await trinkets.list(player2Ctx)).toHaveLength(0)
    })
  })

  it('listByParents refuses a repo that declared no parent, and short-circuits an empty set', async () => {
    await withTestDatabase(async (pool) => {
      const db = createDb(pool)
      await migrateToLatest(db)
      await createTrinketFixture(db)
      const { ownerCtx } = await setupWorld(db, 't4')

      // `trinkets` is built WITHOUT a parentColumn, so there is nothing to
      // filter on. That is a programming error at the call site, not a query
      // returning nothing — an empty array would quietly look like "no rows
      // match". It refuses regardless of the ids passed, including an empty
      // set: the misconfiguration is in the repo, not in the argument.
      await expect(trinkets.listByParents(ownerCtx, ['anything'])).rejects.toThrow('parentColumn')
      await expect(trinkets.listByParents(ownerCtx, [])).rejects.toThrow('parentColumn')
    })
  })

  it('a grant never overrides dm_only, and is specific to the row it names', async () => {
    await withTestDatabase(async (pool) => {
      const db = createDb(pool)
      await migrateToLatest(db)
      await createTrinketFixture(db)
      const { ownerCtx, playerCtx } = await setupWorld(db, 't3')
      const playerId = playerCtx.actor.accountId

      const secret = await trinkets.create(ownerCtx, { name: 'DM Only', visibility: 'dm_only' })
      const granted = await trinkets.create(ownerCtx, { name: 'Granted', visibility: 'restricted' })
      const sibling = await trinkets.create(ownerCtx, { name: 'Sibling', visibility: 'restricted' })

      // a stray grant on a dm_only row must not open it
      await grantTrinket(db, ownerCtx.worldId, secret.id as string, playerId)
      await grantTrinket(db, ownerCtx.worldId, granted.id as string, playerId)

      expect(await trinkets.get(playerCtx, secret.id as string)).toBeUndefined()
      expect(await trinkets.get(playerCtx, granted.id as string)).toMatchObject({ name: 'Granted' })
      expect(await trinkets.get(playerCtx, sibling.id as string)).toBeUndefined()
      expect(await trinkets.list(playerCtx)).toHaveLength(1)
    })
  })
})

describe('content seam — base/detail split and jsonb-array detail columns', () => {
  it('splits writes across entities + detail, merges detail on read, wraps jsonb arrays', async () => {
    await withTestDatabase(async (pool) => {
      const db = createDb(pool)
      await migrateToLatest(db)
      const { ownerCtx } = await setupWorld(db, 'cur')
      const repo = CONTENT_REPOS.currency!

      // create writes a base row + a detail row; `denominations` (a JS array) is
      // jsonb-wrapped so pg doesn't mistake it for a Postgres array literal
      const cur = await repo.create(ownerCtx, {
        name: 'Crown',
        description: 'the realm coin',
        symbol: 'C',
        denominations: [{ name: 'penny', value: 0.01 }],
      })
      const got = (await repo.get(ownerCtx, cur.id)) as Record<string, unknown>
      expect(got.name).toBe('Crown') // base column
      expect(got.symbol).toBe('C') // detail column merged flat
      expect(got.denominations).toEqual([{ name: 'penny', value: 0.01 }]) // jsonb round-trip
      expect(got.entity_id).toBeUndefined() // internal key never leaks

      // update touches a base column AND a jsonb-array detail column at once
      await repo.update(ownerCtx, cur.id, {
        description: 'reminted',
        denominations: [{ name: 'crown', value: 1 }],
      })
      const after = (await repo.get(ownerCtx, cur.id)) as Record<string, unknown>
      expect(after.description).toBe('reminted')
      expect(after.denominations).toEqual([{ name: 'crown', value: 1 }])

      // list also merges the detail row onto every base row
      const listed = await repo.list(ownerCtx)
      expect(listed).toHaveLength(1)
      expect((listed[0] as Record<string, unknown>).symbol).toBe('C')
    })
  })
})
