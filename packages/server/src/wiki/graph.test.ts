import { buildNameIndex } from '@campaign-settings/shared'
import type { Kysely } from 'kysely'
import { describe, expect, it } from 'vitest'
import { createContentRepository } from '../authz/content'
import { resolveWorldContext } from '../authz/context'
import type { WorldContext } from '../data/context'
import { grantEntityVisibility } from '../data/entity-visibility'
import { createLoreArticle } from '../data/lore-articles'
import { createNpc } from '../data/npcs'
import { createPassage, grantPassageVisibility, revokePassageVisibility } from '../data/passages'
import { createTouch } from '../data/touches'
import { DETAIL_SPECS } from '../data/entity-details'
import { newId } from '../db/ids'
import { createDb } from '../db/kysely'
import { migrateToLatest } from '../db/migrator'
import type { Database } from '../db/schema'
import { withTestDatabase } from '../db/test-database'
import { createTenancy } from '../tenancy'
import {
  buildEntityGraph,
  type BracketEntity,
  computeSessionLinks,
  type GraphEdge,
  listSessionsForEntity,
  listWikiEntities,
} from './graph'

const settlements = createContentRepository('entities', {
  kind: 'settlement',
  detail: DETAIL_SPECS.settlement,
})
const sessionsRepo = createContentRepository('sessions', { kind: 'session' })

async function makeAccount(db: Kysely<Database>, username: string): Promise<string> {
  const id = newId()
  await db.insertInto('accounts').values({ id, username, password_hash: 'h' }).execute()
  return id
}

const hasEdge = (edges: GraphEdge[], fromId: string, toId: string): boolean =>
  edges.some((e) => e.from.id === fromId && e.to.id === toId)

describe('entity graph authorization', () => {
  it('owner sees secret nodes and links; a player sees neither endpoint', async () => {
    await withTestDatabase(async (pool) => {
      const db = createDb(pool)
      await migrateToLatest(db)
      const tenancy = createTenancy(db)
      const ownerId = await makeAccount(db, 'dm')
      const playerId = await makeAccount(db, 'player')
      const world = await tenancy.createWorldWithPlayer(ownerId, 'W', playerId)
      const owner = (await resolveWorldContext(db, ownerId, world.slug)) as WorldContext
      const player = (await resolveWorldContext(db, playerId, world.slug)) as WorldContext

      const ashen = await settlements.create(owner, { name: 'Ashenfield', visibility: 'public' })
      const prince = await createNpc(owner, {
        name: 'The Prince',
        visibility: 'dm_only',
        description: 'rules [[Ashenfield]]',
      })
      const mira = await createNpc(owner, {
        name: 'Mira',
        visibility: 'public',
        description: '[[The Prince]] and [[Ashenfield]]',
      })
      const lore = await createLoreArticle(owner, {
        name: 'History',
        visibility: 'public',
        description: 'mentions [[Mira]]',
      })
      // a PC (public by default) linking to Mira — raw base-row insert (the graph
      // only reads the entity's description, so no pc_details row is needed)
      const rolandId = newId()
      await db
        .insertInto('entities')
        .values({
          id: rolandId,
          world_id: world.id,
          kind: 'pc',
          name: 'Roland',
          description: '[[Mira]]',
        })
        .execute()

      const og = await buildEntityGraph(owner)
      expect(og.nodes.map((n) => n.id)).toContain(prince.id) // secret node visible to owner
      expect(hasEdge(og.edges, mira.id, prince.id)).toBe(true) // npc → secret npc
      expect(hasEdge(og.edges, prince.id, ashen.id)).toBe(true) // secret npc → settlement
      expect(hasEdge(og.edges, mira.id, ashen.id)).toBe(true)
      expect(hasEdge(og.edges, lore.id, mira.id)).toBe(true)
      expect(hasEdge(og.edges, rolandId, mira.id)).toBe(true) // pc → npc

      const pg = await buildEntityGraph(player)
      const playerIds = pg.nodes.map((n) => n.id)
      expect(playerIds).not.toContain(prince.id) // secret node hidden
      expect(playerIds).toEqual(expect.arrayContaining([mira.id, ashen.id, lore.id, rolandId]))
      // no edge touches the secret entity through EITHER endpoint
      expect(pg.edges.some((e) => e.from.id === prince.id || e.to.id === prince.id)).toBe(false)
      // visible links survive
      expect(hasEdge(pg.edges, mira.id, ashen.id)).toBe(true)
      expect(hasEdge(pg.edges, rolandId, mira.id)).toBe(true)
    })
  })

  it('drops self-links and de-duplicates repeated links', async () => {
    await withTestDatabase(async (pool) => {
      const db = createDb(pool)
      await migrateToLatest(db)
      const tenancy = createTenancy(db)
      const ownerId = await makeAccount(db, 'dm')
      const world = await tenancy.createWorld(ownerId, 'W')
      const owner = (await resolveWorldContext(db, ownerId, world.slug)) as WorldContext

      const ashen = await settlements.create(owner, { name: 'Ashenfield', visibility: 'public' })
      const echo = await createNpc(owner, {
        name: 'Echo',
        visibility: 'public',
        description: 'I am [[Echo]] near [[Ashenfield]] and [[Ashenfield]]',
      })

      const g = await buildEntityGraph(owner)
      expect(hasEdge(g.edges, echo.id, echo.id)).toBe(false) // no self-edge
      expect(g.edges.filter((e) => e.from.id === echo.id && e.to.id === ashen.id)).toHaveLength(1)
    })
  })

  it('restricted entities: hidden from an ungranted player across graph/wiki/history, visible once granted', async () => {
    await withTestDatabase(async (pool) => {
      const db = createDb(pool)
      await migrateToLatest(db)
      const tenancy = createTenancy(db)
      const ownerId = await makeAccount(db, 'dm')
      const playerId = await makeAccount(db, 'player')
      const world = await tenancy.createWorldWithPlayer(ownerId, 'W', playerId)
      const owner = (await resolveWorldContext(db, ownerId, world.slug)) as WorldContext
      const player = (await resolveWorldContext(db, playerId, world.slug)) as WorldContext

      const cabal = await createNpc(owner, { name: 'The Cabal', visibility: 'restricted' })
      // a public npc + session that both reference the restricted entity
      const mira = await createNpc(owner, {
        name: 'Mira',
        visibility: 'public',
        description: 'fears [[The Cabal]]',
      })
      const session = await sessionsRepo.create(owner, {
        name: 'Session 1',
        captured_text: 'the party met [[The Cabal]]',
      })
      await createTouch(owner, {
        session_id: session.id,
        entity_id: cabal.id,
        touch_type: 'met',
      })

      // ── ungranted player: the restricted entity leaks NOWHERE ──
      const pg = await buildEntityGraph(player)
      expect(pg.nodes.map((n) => n.id)).not.toContain(cabal.id)
      // no edge reaches it through either endpoint (description bracket OR session touch/bracket)
      expect(pg.edges.some((e) => e.from.id === cabal.id || e.to.id === cabal.id)).toBe(false)
      expect((await listWikiEntities(player)).map((e) => e.id)).not.toContain(cabal.id)
      // its session history is not addressable by the ungranted player
      expect(await listSessionsForEntity(player, 'npc', cabal.id)).toHaveLength(0)

      // ── grant → it appears for THAT player across every surface ──
      await grantEntityVisibility(owner, cabal.id, playerId)
      const pg2 = await buildEntityGraph(player)
      expect(pg2.nodes.map((n) => n.id)).toContain(cabal.id)
      expect(hasEdge(pg2.edges, mira.id, cabal.id)).toBe(true) // description edge resolves
      expect(hasEdge(pg2.edges, cabal.id, session.id)).toBe(true) // touch edge resolves
      expect((await listWikiEntities(player)).map((e) => e.id)).toContain(cabal.id)
      expect(await listSessionsForEntity(player, 'npc', cabal.id)).toHaveLength(1)

      // owner always sees it
      expect((await buildEntityGraph(owner)).nodes.map((n) => n.id)).toContain(cabal.id)
    })
  })

  it('builds a graph scoped to its own world', async () => {
    await withTestDatabase(async (pool) => {
      const db = createDb(pool)
      await migrateToLatest(db)
      const tenancy = createTenancy(db)
      const aId = await makeAccount(db, 'a')
      const bId = await makeAccount(db, 'b')
      const worldA = await tenancy.createWorld(aId, 'A')
      const worldB = await tenancy.createWorld(bId, 'B')
      const a = (await resolveWorldContext(db, aId, worldA.slug)) as WorldContext
      const b = (await resolveWorldContext(db, bId, worldB.slug)) as WorldContext

      await createNpc(a, { name: 'A-only', visibility: 'public', description: '' })
      const gB = await buildEntityGraph(b)
      expect(gB.nodes).toHaveLength(0)
      expect(gB.edges).toHaveLength(0)
    })
  })
})

describe('computeSessionLinks', () => {
  const entities: BracketEntity[] = [
    { kind: 'npc', id: 'n1', name: 'Mira', description: '' },
    { kind: 'settlement', id: 's1', name: 'Ashen', description: '' },
  ]
  const index = buildNameIndex([
    { kind: 'npc', rows: [{ id: 'n1', name: 'Mira' }] },
    { kind: 'settlement', rows: [{ id: 's1', name: 'Ashen' }] },
  ])
  const session = (over: Partial<{ id: string; captured_text: string }> = {}) => ({
    id: 'se1',
    name: 'S1',
    played_at: null,
    captured_text: '',
    ...over,
  })

  it('makes a touch link for a visible entity + visible session', () => {
    const links = computeSessionLinks({
      entities,
      index,
      sessions: [session()],
      touches: [{ session_id: 'se1', entity_id: 'n1' }],
    })
    expect(links).toEqual([{ entity: { kind: 'npc', id: 'n1' }, sessionId: 'se1', type: 'touch' }])
  })

  it('drops touches to an invisible entity or unknown session, and dedupes a repeated pair', () => {
    const links = computeSessionLinks({
      entities,
      index,
      sessions: [session()],
      touches: [
        { session_id: 'se1', entity_id: 'hidden' }, // entity not visible
        { session_id: 'gone', entity_id: 'n1' }, // session not visible
        { session_id: 'se1', entity_id: 'n1' }, // real
        { session_id: 'se1', entity_id: 'n1' }, // duplicate pair
      ],
    })
    expect(links).toEqual([{ entity: { kind: 'npc', id: 'n1' }, sessionId: 'se1', type: 'touch' }])
  })

  it('brackets captured_text, deduping repeated names and skipping unresolved ones', () => {
    const links = computeSessionLinks({
      entities,
      index,
      sessions: [session({ captured_text: 'met [[Mira]] then [[Mira]] but not [[Nobody]]' })],
      touches: [],
    })
    expect(links).toEqual([
      { entity: { kind: 'npc', id: 'n1' }, sessionId: 'se1', type: 'bracket' },
    ])
  })

  it('lets a touch win over a bracket for the same entity+session pair', () => {
    const links = computeSessionLinks({
      entities,
      index,
      sessions: [session({ captured_text: 'met [[Mira]]' })],
      touches: [{ session_id: 'se1', entity_id: 'n1' }],
    })
    expect(links).toEqual([{ entity: { kind: 'npc', id: 'n1' }, sessionId: 'se1', type: 'touch' }])
  })
})

/**
 * The leak passages introduce, and the one this chain exists to prevent.
 *
 * Before passages, "an edge exists only when both endpoints are visible" fell
 * out by construction: the edge SOURCE TEXT was a column on an authorized row,
 * so a player parsing it could only ever reach entities they could already see.
 *
 * Passages make that source text viewer-dependent, and a new leak becomes
 * expressible. Put a `[[link]]` inside a dm_only passage on a PUBLIC npc,
 * pointing at another PUBLIC entity. Both endpoints are legitimately visible to
 * the player. The secret is the EXISTENCE OF THE CONNECTION — that these two
 * are related at all — and both-endpoints-visible cannot catch it, because both
 * endpoints ARE visible.
 *
 * Nodes are a different question and deliberately unchanged: the graph API
 * ships only {kind, id, name}, so a node carries nothing to leak.
 */
describe('graph edges — a link inside a hidden passage is not an edge', () => {
  async function twoPublicEntities(db: Kysely<Database>, prefix: string) {
    const tenancy = createTenancy(db)
    const ownerId = await makeAccount(db, `${prefix}-dm`)
    const playerId = await makeAccount(db, `${prefix}-player`)
    const world = await tenancy.createWorldWithPlayer(ownerId, prefix, playerId)
    const owner = (await resolveWorldContext(db, ownerId, world.slug)) as WorldContext
    const player = (await resolveWorldContext(db, playerId, world.slug)) as WorldContext

    const crow = await createNpc(owner, {
      name: 'Silas Crow',
      visibility: 'public',
      description: 'A fishmonger with ink-stained cuffs.',
    })
    const hollow = await createNpc(owner, {
      name: 'The Hollow Man',
      visibility: 'public',
      description: 'A rumour with a hat.',
    })
    return { world, ownerId, playerId, owner, player, crow, hollow }
  }

  it('hides the edge from a player while both NODES stay visible to them', async () => {
    await withTestDatabase(async (pool) => {
      const db = createDb(pool)
      await migrateToLatest(db)
      const w = await twoPublicEntities(db, 'leak1')

      await createPassage(
        w.owner,
        {
          entityId: w.crow.id,
          body: 'He answers to [[The Hollow Man]].',
          visibility: 'dm_only',
        },
        w.ownerId,
      )

      const asOwner = await buildEntityGraph(w.owner)
      const asPlayer = await buildEntityGraph(w.player)

      // the connection is the secret, and only the owner may see it
      expect(hasEdge(asOwner.edges, w.crow.id, w.hollow.id)).toBe(true)
      expect(hasEdge(asPlayer.edges, w.crow.id, w.hollow.id)).toBe(false)

      // ...but both entities are public, so both NODES remain on both graphs.
      // Dropping a node here would be a different bug: hiding an entity the
      // player is entitled to browse.
      const playerNodeIds = asPlayer.nodes.map((n) => n.id)
      expect(playerNodeIds).toContain(w.crow.id)
      expect(playerNodeIds).toContain(w.hollow.id)
    })
  })

  it('follows the grant when the passage is restricted rather than dm_only', async () => {
    await withTestDatabase(async (pool) => {
      const db = createDb(pool)
      await migrateToLatest(db)
      const w = await twoPublicEntities(db, 'leak2')
      const tenancy = createTenancy(db)
      const otherId = await makeAccount(db, 'leak2-player2')
      await tenancy.grantMember(w.ownerId, w.world.id, otherId)
      const other = (await resolveWorldContext(db, otherId, w.world.slug)) as WorldContext

      const p = await createPassage(
        w.owner,
        {
          entityId: w.crow.id,
          body: 'He answers to [[The Hollow Man]].',
          visibility: 'restricted',
        },
        w.ownerId,
      )

      // ungranted: no edge for anyone but the owner
      expect(hasEdge((await buildEntityGraph(w.player)).edges, w.crow.id, w.hollow.id)).toBe(false)
      expect(hasEdge((await buildEntityGraph(other)).edges, w.crow.id, w.hollow.id)).toBe(false)

      await grantPassageVisibility(w.owner, p.id, w.playerId)

      // the grant reaches exactly one player, and the graph follows the prose
      expect(hasEdge((await buildEntityGraph(w.player)).edges, w.crow.id, w.hollow.id)).toBe(true)
      expect(hasEdge((await buildEntityGraph(other)).edges, w.crow.id, w.hollow.id)).toBe(false)

      await revokePassageVisibility(w.owner, p.id, w.playerId)
      expect(hasEdge((await buildEntityGraph(w.player)).edges, w.crow.id, w.hollow.id)).toBe(false)
    })
  })

  it('still builds an edge from a PUBLIC passage, for everyone', async () => {
    await withTestDatabase(async (pool) => {
      const db = createDb(pool)
      await migrateToLatest(db)
      const w = await twoPublicEntities(db, 'leak3')

      await createPassage(
        w.owner,
        {
          entityId: w.crow.id,
          body: 'Seen drinking with [[The Hollow Man]].',
          visibility: 'public',
        },
        w.ownerId,
      )

      expect(hasEdge((await buildEntityGraph(w.owner)).edges, w.crow.id, w.hollow.id)).toBe(true)
      expect(hasEdge((await buildEntityGraph(w.player)).edges, w.crow.id, w.hollow.id)).toBe(true)
    })
  })
})
