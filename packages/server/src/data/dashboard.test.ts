import type { Kysely } from 'kysely'
import { describe, expect, it } from 'vitest'
import { createContentRepository } from '../authz/content'
import { resolveWorldContext } from '../authz/context'
import { newId } from '../db/ids'
import { createDb } from '../db/kysely'
import { migrateToLatest } from '../db/migrator'
import type { Database } from '../db/schema'
import { withTestDatabase } from '../db/test-database'
import { createTenancy } from '../tenancy'
import { CONTENT_REPOS, ENTITY_REPOS } from './content-repos'
import type { WorldContext } from './context'
import { buildWorldDashboard, orderSessions } from './dashboard'
import { grantEntityVisibility } from './entity-visibility'
import { createTouch } from './touches'

const sessionsRepo = createContentRepository('sessions', { kind: 'session' })
const npcs = () => CONTENT_REPOS.npc!
const pcs = () => CONTENT_REPOS.pc!

async function makeAccount(db: Kysely<Database>, username: string): Promise<string> {
  const id = newId()
  await db.insertInto('accounts').values({ id, username, password_hash: 'h' }).execute()
  return id
}

/** A world with a DM and one member player, resolved to both contexts. */
async function setup(db: Kysely<Database>) {
  const tenancy = createTenancy(db)
  const dmId = await makeAccount(db, 'dm')
  const playerId = await makeAccount(db, 'rowan')
  const world = await tenancy.createWorldWithPlayer(dmId, 'W', playerId)
  const dm = (await resolveWorldContext(db, dmId, world.slug)) as WorldContext
  const player = (await resolveWorldContext(db, playerId, world.slug)) as WorldContext
  return { db, world, dm, player, dmId, playerId }
}

describe('orderSessions', () => {
  it('puts dated sessions first, newest date first, with undated ones last', () => {
    const rows = [
      { id: 'undated', played_at: null, updated_at: '2026-08-01T00:00:00Z' },
      { id: 'old', played_at: '2026-01-01', updated_at: '2026-01-01T00:00:00Z' },
      { id: 'new', played_at: '2026-06-01', updated_at: '2026-01-01T00:00:00Z' },
    ]
    expect(orderSessions(rows).map((r) => r.id)).toEqual(['new', 'old', 'undated'])
  })

  it('breaks a tie on updated_at, so a freshly edited undated session rises', () => {
    // This is the decision Sophi made explicitly: she reaches for what she has
    // recently touched, and every session in the real spirit-call world is
    // undated, so this branch is the normal case rather than an edge.
    const rows = [
      { id: 'stale', played_at: null, updated_at: '2026-08-01T00:00:00Z' },
      { id: 'edited', played_at: null, updated_at: '2026-08-20T00:00:00Z' },
    ]
    expect(orderSessions(rows).map((r) => r.id)).toEqual(['edited', 'stale'])
  })

  it('ranks a dated session above an undated one whichever order they arrive in', () => {
    const dated = { id: 'dated', played_at: '2026-01-01', updated_at: '2026-01-01T00:00:00Z' }
    const undated = { id: 'undated', played_at: null, updated_at: '2026-08-01T00:00:00Z' }
    expect(orderSessions([dated, undated]).map((r) => r.id)).toEqual(['dated', 'undated'])
    expect(orderSessions([undated, dated]).map((r) => r.id)).toEqual(['dated', 'undated'])
  })

  it('does not mutate its input', () => {
    const rows = [
      { played_at: null, updated_at: '2026-01-01T00:00:00Z' },
      { played_at: '2026-01-01', updated_at: '2026-01-01T00:00:00Z' },
    ]
    orderSessions(rows)
    expect(rows[0]!.played_at).toBeNull()
  })
})

describe('the world dashboard', () => {
  it('is empty in every panel for a world with nothing in it', async () => {
    await withTestDatabase(async (pool) => {
      const db = createDb(pool)
      await migrateToLatest(db)
      const { dm } = await setup(db)

      const d = await buildWorldDashboard(dm)
      expect(d.session).toBeNull()
      expect(d.party).toEqual([])
      expect(d.myCharacter).toBeNull()
      // Every registry kind is present at zero, so the quick-link row is never
      // ragged and a caller need not distinguish "absent" from "none".
      expect(d.counts.npc).toBe(0)
      expect(d.counts.map).toBe(0)
      expect(d.counts.session).toBe(0)
    })
  })

  it('says which rule placed the session, and reports the undated case honestly', async () => {
    await withTestDatabase(async (pool) => {
      const db = createDb(pool)
      await migrateToLatest(db)
      const { dm } = await setup(db)

      await sessionsRepo.create(dm, { name: 'Undated', captured_text: 'x' })
      const undated = await buildWorldDashboard(dm)
      expect(undated.session?.name).toBe('Undated')
      expect(undated.session?.playedAt).toBeNull()
      expect(undated.session?.ordering).toBe('updated_at')

      await sessionsRepo.create(dm, { name: 'Dated', played_at: '2026-06-01' })
      const dated = await buildWorldDashboard(dm)
      expect(dated.session?.name).toBe('Dated')
      expect(dated.session?.ordering).toBe('played_at')
    })
  })

  it('carries the session’s touched entities, resolved to names and kinds', async () => {
    await withTestDatabase(async (pool) => {
      const db = createDb(pool)
      await migrateToLatest(db)
      const { dm } = await setup(db)

      const mira = await npcs().create(dm, { name: 'Mira', visibility: 'public' })
      const session = await sessionsRepo.create(dm, { name: 'S1' })
      await createTouch(dm, { session_id: session.id, entity_id: mira.id, touch_type: 'met' })

      const d = await buildWorldDashboard(dm)
      expect(d.session?.touches).toEqual([
        {
          id: expect.any(String),
          entityId: mira.id,
          entityKind: 'npc',
          entityName: 'Mira',
          touchType: 'met',
        },
      ])
    })
  })

  it('drops a touch whose entity the viewer cannot see, and restores it on a grant', async () => {
    await withTestDatabase(async (pool) => {
      const db = createDb(pool)
      await migrateToLatest(db)
      const { dm, player, playerId } = await setup(db)

      const cabal = await npcs().create(dm, { name: 'The Cabal', visibility: 'restricted' })
      const session = await sessionsRepo.create(dm, { name: 'S1', visibility: 'public' })
      await createTouch(dm, { session_id: session.id, entity_id: cabal.id, touch_type: 'met' })

      // A touch has no visibility of its own — its endpoints carry the rule, so
      // an unseeable entity must not reach the player's panel by this route.
      expect((await buildWorldDashboard(player)).session?.touches).toEqual([])
      expect((await buildWorldDashboard(dm)).session?.touches).toHaveLength(1)

      await grantEntityVisibility(dm, cabal.id, playerId)
      expect((await buildWorldDashboard(player)).session?.touches).toHaveLength(1)
    })
  })

  it('hides a dm_only session from a player entirely, falling back to the next one', async () => {
    await withTestDatabase(async (pool) => {
      const db = createDb(pool)
      await migrateToLatest(db)
      const { dm, player } = await setup(db)

      await sessionsRepo.create(dm, { name: 'Public one', played_at: '2026-01-01' })
      await sessionsRepo.create(dm, {
        name: 'The secret one',
        played_at: '2026-06-01',
        visibility: 'dm_only',
      })

      expect((await buildWorldDashboard(dm)).session?.name).toBe('The secret one')
      expect((await buildWorldDashboard(player)).session?.name).toBe('Public one')
    })
  })

  it('names each character’s player, and says so when a character has none', async () => {
    await withTestDatabase(async (pool) => {
      const db = createDb(pool)
      await migrateToLatest(db)
      const { dm, playerId } = await setup(db)

      await pcs().create(dm, { name: 'Lun', visibility: 'public' })
      const bright = await pcs().create(dm, {
        name: 'Bright',
        visibility: 'public',
        account_id: playerId,
      })

      const party = (await buildWorldDashboard(dm)).party
      expect(party.map((p) => [p.name, p.playerName]).sort()).toEqual([
        ['Bright', 'rowan'],
        ['Lun', null],
      ])
      expect(party.find((p) => p.id === bright.id)?.accountId).toBe(playerId)
    })
  })

  it('resolves the viewer’s own character through the account link', async () => {
    await withTestDatabase(async (pool) => {
      const db = createDb(pool)
      await migrateToLatest(db)
      const { dm, player, playerId } = await setup(db)

      expect((await buildWorldDashboard(player)).myCharacter).toBeNull()

      const bright = await pcs().create(dm, {
        name: 'Bright',
        visibility: 'public',
        account_id: playerId,
      })
      expect((await buildWorldDashboard(player)).myCharacter?.id).toBe(bright.id)
      // The DM plays nobody, so their own-character slot stays empty.
      expect((await buildWorldDashboard(dm)).myCharacter).toBeNull()
    })
  })

  it('counts what each viewer may see, so a player’s numbers are their own', async () => {
    await withTestDatabase(async (pool) => {
      const db = createDb(pool)
      await migrateToLatest(db)
      const { dm, player } = await setup(db)

      await npcs().create(dm, { name: 'Public NPC', visibility: 'public' })
      await npcs().create(dm, { name: 'Secret NPC', visibility: 'dm_only' })
      await sessionsRepo.create(dm, { name: 'S1', visibility: 'public' })
      await ENTITY_REPOS.map!.create(dm, { name: 'Overland', visibility: 'public' })
      await ENTITY_REPOS.map!.create(dm, { name: 'The dungeon', visibility: 'dm_only' })

      // A second NPC proves the tally increments rather than only initialising.
      await npcs().create(dm, { name: 'Another public NPC', visibility: 'public' })

      const dmCounts = (await buildWorldDashboard(dm)).counts
      const playerCounts = (await buildWorldDashboard(player)).counts
      expect([dmCounts.npc, playerCounts.npc]).toEqual([3, 2])
      expect([dmCounts.map, playerCounts.map]).toEqual([2, 1])
      expect([dmCounts.session, playerCounts.session]).toEqual([1, 1])
    })
  })
})
