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
import { createPassage, deletePassage, grantPassageVisibility, updatePassage } from './passages'
import { bestSources, isUnspecified, reconcileBrackets } from './relationship-reconcile'
import {
  asRelationshipError,
  createRelationship,
  DuplicateRelationshipError,
  InvalidQualifierError,
  listRelationshipsForEntity,
  updateRelationship,
} from './relationships'

const npcs = () => CONTENT_REPOS.npc!

async function makeAccount(db: Kysely<Database>, username: string): Promise<string> {
  const id = newId()
  await db.insertInto('accounts').values({ id, username, password_hash: 'h' }).execute()
  return id
}

async function setup(db: Kysely<Database>) {
  const tenancy = createTenancy(db)
  const dmId = await makeAccount(db, 'dm')
  const playerId = await makeAccount(db, 'rowan')
  const otherId = await makeAccount(db, 'sam')
  const world = await tenancy.createWorldWithPlayer(dmId, 'W', playerId)
  await tenancy.grantMember(dmId, world.id, otherId)
  const dm = (await resolveWorldContext(db, dmId, world.slug)) as WorldContext
  const player = (await resolveWorldContext(db, playerId, world.slug)) as WorldContext
  const other = (await resolveWorldContext(db, otherId, world.slug)) as WorldContext
  return { db, dm, player, other, dmId, playerId, otherId }
}

/** The relationship rows as one entity's page reads them, for the given actor. */
const relations = (ctx: WorldContext, id: string) => listRelationshipsForEntity(ctx, id)

/** Set an entity's description and reconcile, as a save through the route does. */
async function save(ctx: WorldContext, id: string, description: string): Promise<void> {
  await npcs().update(ctx, id, { description })
  await reconcileBrackets(ctx, id)
}

describe('bestSources', () => {
  const resolve = (name: string) => (name === 'Mira' ? 'mira' : name === 'Silas' ? 'silas' : null)

  it('drops names that resolve to nothing, and self-references', () => {
    const got = bestSources(
      [{ passageId: null, text: 'Met [[Nobody]] and [[Me]] and [[Mira]]', rank: 0 }],
      (n) => (n === 'Me' ? 'self' : resolve(n)),
      'self',
    )
    expect([...got.keys()]).toEqual(['mira'])
  })

  it('prefers the base description over any passage', () => {
    const got = bestSources(
      [
        { passageId: null, text: 'Knows [[Mira]]', rank: 0 },
        { passageId: 'p1', text: 'Also knows [[Mira]]', rank: 1 },
      ],
      resolve,
      'self',
    )
    expect(got.get('mira')).toBeNull()
  })

  it('prefers the MOST VISIBLE passage when the description does not mention it', () => {
    // A pair named in both a public reveal and a secret one is not a secret.
    // Picking the least visible source would hide a link already published.
    const got = bestSources(
      [
        { passageId: null, text: 'no links here', rank: 0 },
        { passageId: 'secret', text: 'Knows [[Mira]]', rank: 3 },
        { passageId: 'open', text: 'Knows [[Mira]]', rank: 1 },
      ],
      resolve,
      'self',
    )
    expect(got.get('mira')).toBe('open')
  })

  it('deduplicates a name repeated in one source, whatever its capitalisation', () => {
    const got = bestSources(
      [{ passageId: null, text: '[[Mira]] and [[mira]] and [[Silas]]', rank: 0 }],
      (n) => resolve(n.charAt(0).toUpperCase() + n.slice(1)),
      'self',
    )
    expect([...got.keys()].sort()).toEqual(['mira', 'silas'])
  })
})

describe('asRelationshipError', () => {
  it('names a unique collision and hands anything else back untouched', () => {
    // Both write paths go through here, so they cannot come to describe the
    // same collision differently.
    expect(asRelationshipError({ code: '23505' })).toBeInstanceOf(DuplicateRelationshipError)
    const other = new Error('connection reset')
    expect(asRelationshipError(other)).toBe(other)
    expect(asRelationshipError(null)).toBeNull()
  })
})

describe('isUnspecified', () => {
  it('is true only for a bare related_to with no note and no qualifier', () => {
    expect(isUnspecified({ type: 'related_to', note: '', qualifier: null })).toBe(true)
    expect(isUnspecified({ type: 'related_to', note: '   ', qualifier: null })).toBe(true)
    expect(isUnspecified({ type: 'ally_of', note: '', qualifier: null })).toBe(false)
    expect(isUnspecified({ type: 'related_to', note: 'since the fire', qualifier: null })).toBe(
      false,
    )
    expect(isUnspecified({ type: 'related_to', note: '', qualifier: 'native' })).toBe(false)
  })
})

describe('reconciling brackets into relationships', () => {
  it('creates a relationship from a bracket, and retires it when the bracket goes', async () => {
    await withTestDatabase(async (pool) => {
      const db = createDb(pool)
      await migrateToLatest(db)
      const { dm } = await setup(db)
      const mira = await npcs().create(dm, { name: 'Mira', visibility: 'public' })
      const silas = await npcs().create(dm, { name: 'Silas', visibility: 'public' })

      await save(dm, silas.id, 'Owes [[Mira]] a favour.')
      const after = await relations(dm, silas.id)
      expect(after).toHaveLength(1)
      expect(after[0]?.type).toBe('related_to')
      expect(after[0]?.other.id).toBe(mira.id)
      // And it reads from the far end too, like any relationship.
      expect((await relations(dm, mira.id))[0]?.other.id).toBe(silas.id)

      await save(dm, silas.id, 'Owes nobody anything.')
      expect(await relations(dm, silas.id)).toEqual([])
    })
  })

  it('changes nothing when the body is saved unchanged', async () => {
    await withTestDatabase(async (pool) => {
      const db = createDb(pool)
      await migrateToLatest(db)
      const { dm } = await setup(db)
      await npcs().create(dm, { name: 'Mira', visibility: 'public' })
      const silas = await npcs().create(dm, { name: 'Silas', visibility: 'public' })

      await save(dm, silas.id, 'Owes [[Mira]] a favour.')
      const first = await db
        .selectFrom('entity_relationships')
        .select(['id', 'updated_at'])
        .execute()

      await reconcileBrackets(dm, silas.id)
      await reconcileBrackets(dm, silas.id)
      const second = await db
        .selectFrom('entity_relationships')
        .select(['id', 'updated_at'])
        .execute()

      // Same row, untouched. This runs on every save, and a version that
      // rewrote its rows each time would churn updated_at on nobody's data.
      expect(second).toEqual(first)
    })
  })

  it('never retires a hand-authored row, however the prose is reworded', async () => {
    await withTestDatabase(async (pool) => {
      const db = createDb(pool)
      await migrateToLatest(db)
      const { dm } = await setup(db)
      const mira = await npcs().create(dm, { name: 'Mira', visibility: 'public' })
      const silas = await npcs().create(dm, { name: 'Silas', visibility: 'public' })

      await db
        .insertInto('entity_relationships')
        .values({
          id: newId(),
          world_id: dm.worldId,
          from_id: silas.id,
          to_id: mira.id,
          type: 'ally_of',
          origin: 'authored',
        })
        .execute()

      // A mention of an already-stated pair adds nothing: a bare "Related to"
      // beside "Ally of" says strictly less than the row already there.
      await save(dm, silas.id, 'Trusts [[Mira]].')
      expect(await relations(dm, silas.id)).toHaveLength(1)
      expect((await relations(dm, silas.id))[0]?.type).toBe('ally_of')

      await save(dm, silas.id, 'Says nothing about anyone.')
      expect((await relations(dm, silas.id))[0]?.type).toBe('ally_of')
    })
  })

  it('keeps a SPECIFIED bracket-derived row when its bracket goes', async () => {
    await withTestDatabase(async (pool) => {
      const db = createDb(pool)
      await migrateToLatest(db)
      const { dm } = await setup(db)
      await npcs().create(dm, { name: 'Mira', visibility: 'public' })
      const silas = await npcs().create(dm, { name: 'Silas', visibility: 'public' })

      await save(dm, silas.id, 'Owes [[Mira]] a favour.')
      const derived = (await relations(dm, silas.id))[0]!
      // The GM says what the link actually is. The literal retirement rule
      // would destroy this the moment someone rephrased the sentence.
      await updateRelationship(dm, derived.id, { type: 'ally_of' })

      await save(dm, silas.id, 'Says nothing about anyone.')
      const kept = await relations(dm, silas.id)
      expect(kept).toHaveLength(1)
      expect(kept[0]?.type).toBe('ally_of')
    })
  })

  it('does not duplicate a pair that mentions itself from both ends', async () => {
    await withTestDatabase(async (pool) => {
      const db = createDb(pool)
      await migrateToLatest(db)
      const { dm } = await setup(db)
      const mira = await npcs().create(dm, { name: 'Mira', visibility: 'public' })
      const silas = await npcs().create(dm, { name: 'Silas', visibility: 'public' })

      await save(dm, silas.id, 'Owes [[Mira]] a favour.')
      await save(dm, mira.id, 'Is owed one by [[Silas]].')

      // Two rows would render the pair twice on each page. The unique index is
      // on the ORDERED triple, so it does not catch this by itself.
      expect(await relations(dm, silas.id)).toHaveLength(1)
      expect(await relations(dm, mira.id)).toHaveLength(1)
    })
  })
  it('moves a row to a MORE visible source when one appears', async () => {
    await withTestDatabase(async (pool) => {
      const db = createDb(pool)
      await migrateToLatest(db)
      const { dm, player, dmId } = await setup(db)
      await npcs().create(dm, { name: 'Mira', visibility: 'public' })
      const silas = await npcs().create(dm, { name: 'Silas', visibility: 'public' })

      // Named only in a secret reveal at first, so only the GM sees the link.
      await createPassage(
        dm,
        { entityId: silas.id, body: 'He answers to [[Mira]].', visibility: 'dm_only' },
        dmId,
      )
      await reconcileBrackets(dm, silas.id)
      expect(await relations(player, silas.id)).toEqual([])

      // Then the description says it too. One row, at its MOST visible source —
      // a pair the public prose names is not a secret any more.
      await save(dm, silas.id, 'Drinks with [[Mira]].')
      expect(await relations(dm, silas.id)).toHaveLength(1)
      expect(await relations(player, silas.id)).toHaveLength(1)
    })
  })

  it('does nothing for an entity that is not there, rather than failing', async () => {
    await withTestDatabase(async (pool) => {
      const db = createDb(pool)
      await migrateToLatest(db)
      const { dm } = await setup(db)
      // A caller reconciling an absent or soft-deleted entity is asking for its
      // links to be correct, and "it has no text" is a truthful answer.
      await expect(reconcileBrackets(dm, 'no-such-entity')).resolves.toBeUndefined()
    })
  })

  it('refuses to run for a player, like every other content write', async () => {
    await withTestDatabase(async (pool) => {
      const db = createDb(pool)
      await migrateToLatest(db)
      const { dm, player } = await setup(db)
      const silas = await npcs().create(dm, { name: 'Silas', visibility: 'public' })
      await expect(reconcileBrackets(player, silas.id)).rejects.toBeInstanceOf(ForbiddenError)
    })
  })

  it('refuses to retype a row onto a relation the pair already holds', async () => {
    await withTestDatabase(async (pool) => {
      const db = createDb(pool)
      await migrateToLatest(db)
      const { dm } = await setup(db)
      const mira = await npcs().create(dm, { name: 'Mira', visibility: 'public' })
      const silas = await npcs().create(dm, { name: 'Silas', visibility: 'public' })

      await createRelationship(dm, { fromId: silas.id, toId: mira.id, type: 'ally_of' })
      const second = await createRelationship(dm, {
        fromId: silas.id,
        toId: mira.id,
        type: 'rival_of',
      })

      // The same collision a duplicate create is, and it deserves the same
      // sentence rather than a 500 naming an index.
      await expect(updateRelationship(dm, second.id, { type: 'ally_of' })).rejects.toBeInstanceOf(
        DuplicateRelationshipError,
      )
    })
  })

  it('refuses a qualifier the RESULTING type has no vocabulary for', async () => {
    await withTestDatabase(async (pool) => {
      const db = createDb(pool)
      await migrateToLatest(db)
      const { dm } = await setup(db)
      const mira = await npcs().create(dm, { name: 'Mira', visibility: 'public' })
      const silas = await npcs().create(dm, { name: 'Silas', visibility: 'public' })
      const row = await createRelationship(dm, {
        fromId: silas.id,
        toId: mira.id,
        type: 'ally_of',
      })

      await expect(updateRelationship(dm, row.id, { qualifier: 'native' })).rejects.toBeInstanceOf(
        InvalidQualifierError,
      )
    })
  })

  it('answers undefined for an id that is not there', async () => {
    await withTestDatabase(async (pool) => {
      const db = createDb(pool)
      await migrateToLatest(db)
      const { dm } = await setup(db)
      expect(await updateRelationship(dm, 'no-such-row', { type: 'ally_of' })).toBeUndefined()
    })
  })
})

describe('a relationship sourced from a reveal', () => {
  it('is invisible to an ungranted player, and appears once the reveal is granted', async () => {
    await withTestDatabase(async (pool) => {
      const db = createDb(pool)
      await migrateToLatest(db)
      const { dm, player, dmId, playerId } = await setup(db)
      // BOTH endpoints public. The secret is not either of them — it is that
      // the two are connected at all.
      const mira = await npcs().create(dm, { name: 'Mira', visibility: 'public' })
      const silas = await npcs().create(dm, { name: 'Silas', visibility: 'public' })

      // `restricted`, not `dm_only`: a grant is what this test is about, and
      // the seam admits a grant only for a restricted row — a dm_only passage
      // is the GM's alone whatever grants name it.
      const reveal = await createPassage(
        dm,
        { entityId: silas.id, body: 'In truth he answers to [[Mira]].', visibility: 'restricted' },
        dmId,
      )
      await reconcileBrackets(dm, silas.id)

      expect((await relations(dm, silas.id))[0]?.other.id).toBe(mira.id)
      expect(await relations(player, silas.id)).toEqual([])
      // …and from the far end too: the rule is about the row, not the page.
      expect(await relations(player, mira.id)).toEqual([])

      // Granting the REVEAL reveals its relationship. No second write.
      await grantPassageVisibility(dm, reveal.id, playerId)
      expect((await relations(player, silas.id))[0]?.other.id).toBe(mira.id)
      expect((await relations(player, mira.id))[0]?.other.id).toBe(silas.id)
    })
  })

  it('appears for everyone once the reveal itself is made public', async () => {
    await withTestDatabase(async (pool) => {
      const db = createDb(pool)
      await migrateToLatest(db)
      const { dm, player, dmId } = await setup(db)
      await npcs().create(dm, { name: 'Mira', visibility: 'public' })
      const silas = await npcs().create(dm, { name: 'Silas', visibility: 'public' })

      const reveal = await createPassage(
        dm,
        { entityId: silas.id, body: 'He answers to [[Mira]].', visibility: 'dm_only' },
        dmId,
      )
      await reconcileBrackets(dm, silas.id)
      expect(await relations(player, silas.id)).toEqual([])

      // Raising the passage's visibility is the ONLY write. The row's audience
      // is derived from it, so nothing on the relationship changes.
      await updatePassage(dm, reveal.id, { visibility: 'public' })
      await reconcileBrackets(dm, silas.id)
      expect(await relations(player, silas.id)).toHaveLength(1)
    })
  })

  it('keeps its source when the GM specifies it, so typing it does not publish it', async () => {
    await withTestDatabase(async (pool) => {
      const db = createDb(pool)
      await migrateToLatest(db)
      const { dm, player, dmId } = await setup(db)
      await npcs().create(dm, { name: 'Mira', visibility: 'public' })
      const silas = await npcs().create(dm, { name: 'Silas', visibility: 'public' })

      const reveal = await createPassage(
        dm,
        { entityId: silas.id, body: 'He answers to [[Mira]].', visibility: 'dm_only' },
        dmId,
      )
      await reconcileBrackets(dm, silas.id)
      const derived = (await relations(dm, silas.id))[0]!
      await updateRelationship(dm, derived.id, { type: 'member_of', note: 'sworn' })

      // Losing reconciliation provenance is not losing visibility provenance.
      // A row that forgot its source here would publish the secret the moment
      // the GM described it more precisely.
      expect(await relations(player, silas.id)).toEqual([])

      // And removing the bracket keeps the specified row AND its source.
      await updatePassage(dm, reveal.id, { body: 'He answers to nobody.' })
      await reconcileBrackets(dm, silas.id)
      expect((await relations(dm, silas.id))[0]?.type).toBe('member_of')
      expect(await relations(player, silas.id)).toEqual([])
    })
  })

  it('falls back to the description when the reveal that also named the pair goes', async () => {
    await withTestDatabase(async (pool) => {
      const db = createDb(pool)
      await migrateToLatest(db)
      const { dm, player, dmId } = await setup(db)
      await npcs().create(dm, { name: 'Mira', visibility: 'public' })
      const silas = await npcs().create(dm, { name: 'Silas', visibility: 'public' })

      // Named in BOTH the public description and a secret reveal. The public
      // statement wins, so the pair is not hidden by the secret one.
      await npcs().update(dm, silas.id, { description: 'Drinks with [[Mira]].' })
      const reveal = await createPassage(
        dm,
        { entityId: silas.id, body: 'And answers to [[Mira]].', visibility: 'dm_only' },
        dmId,
      )
      await reconcileBrackets(dm, silas.id)
      expect(await relations(player, silas.id)).toHaveLength(1)

      // Deleting the reveal leaves the description's link standing.
      await deletePassage(dm, reveal.id)
      await reconcileBrackets(dm, silas.id)
      expect(await relations(player, silas.id)).toHaveLength(1)
    })
  })

  it('retires the row when the reveal that was its only source is deleted', async () => {
    await withTestDatabase(async (pool) => {
      const db = createDb(pool)
      await migrateToLatest(db)
      const { dm, dmId } = await setup(db)
      await npcs().create(dm, { name: 'Mira', visibility: 'public' })
      const silas = await npcs().create(dm, { name: 'Silas', visibility: 'public' })

      const reveal = await createPassage(
        dm,
        { entityId: silas.id, body: 'He answers to [[Mira]].', visibility: 'dm_only' },
        dmId,
      )
      await reconcileBrackets(dm, silas.id)
      expect(await relations(dm, silas.id)).toHaveLength(1)

      // Passages are SOFT-deleted, so the foreign key's cascade never fires —
      // reconciliation is what retires the rows the passage sourced.
      await deletePassage(dm, reveal.id)
      await reconcileBrackets(dm, silas.id)
      expect(await relations(dm, silas.id)).toEqual([])
    })
  })

  it('still refuses a row whose far endpoint is hidden, reveal or no reveal', async () => {
    await withTestDatabase(async (pool) => {
      const db = createDb(pool)
      await migrateToLatest(db)
      const { dm, player } = await setup(db)
      await npcs().create(dm, { name: 'Mira', visibility: 'dm_only' })
      const silas = await npcs().create(dm, { name: 'Silas', visibility: 'public' })

      // The passage filter is an ADDITIONAL condition, never a replacement:
      // a row sourced from the public description is still dropped when the
      // entity at its far end is not this player's to see.
      await save(dm, silas.id, 'Drinks with [[Mira]].')
      expect(await relations(dm, silas.id)).toHaveLength(1)
      expect(await relations(player, silas.id)).toEqual([])
    })
  })
})
