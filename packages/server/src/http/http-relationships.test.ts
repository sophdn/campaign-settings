import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify'
import type { Pool } from 'pg'
import { describe, expect, it } from 'vitest'
import { createScryptAuth } from '../auth/service'
import { grantEntityVisibility } from '../data/entity-visibility'
import { createDb } from '../db/kysely'
import { migrateToLatest } from '../db/migrator'
import { withTestDatabase } from '../db/test-database'
import { openFlags } from '../flags/config'
import { buildApp } from './app'

/**
 * Typed relationships between entities.
 *
 * The block that matters most is the last: a relationship NAMES two entities, so
 * a player entitled to see one may not be entitled to see the other. The content
 * seam filters a row by its own visibility column and a relationship has none of
 * its own, so this is a rule the seam cannot apply on the row's behalf — which is
 * exactly why it gets negative-path tests rather than being assumed.
 */

const SECRET = 'test-secret-test-secret-test-secret'
const PW = 'pw-123456'

interface Harness {
  app: FastifyInstance
  slug: string
  dm: string
  granted: string
  ungranted: string
  guild: string
  publicNpc: string
  dmOnlyNpc: string
  restrictedNpc: string
}

async function withHarness(body: (h: Harness) => Promise<void>): Promise<void> {
  await withTestDatabase(async (pool: Pool) => {
    const db = createDb(pool)
    await migrateToLatest(db)
    const auth = createScryptAuth(db)
    const app = buildApp({
      db,
      auth,
      cookieSecret: SECRET,
      cookieSecure: false,
      flags: openFlags(),
    })
    await app.ready()
    try {
      const dmAccount = await auth.createAccount('dm', PW)
      const grantedAccount = await auth.createAccount('granted', PW)
      const ungrantedAccount = await auth.createAccount('ungranted', PW)
      const dm = await login(app, 'dm')

      const world = await app.inject({
        method: 'POST',
        url: '/api/worlds',
        headers: { cookie: dm },
        payload: { name: 'W' },
      })
      const slug = world.json().world.slug as string
      const worldId = world.json().world.id as string
      for (const account of [grantedAccount, ungrantedAccount]) {
        await app.inject({
          method: 'POST',
          url: `/api/worlds/${slug}/members`,
          headers: { cookie: dm },
          payload: { accountId: account.id },
        })
      }

      const make = async (kind: string, name: string, visibility: string): Promise<string> => {
        const res = await app.inject({
          method: 'POST',
          url: `/api/worlds/${slug}/entities/${kind}`,
          headers: { cookie: dm },
          payload: { name, visibility },
        })
        return res.json().entity.id as string
      }
      const restrictedNpc = await make('npc', 'Silas Crow', 'restricted')
      await grantEntityVisibility(
        { db, worldId, actor: { accountId: dmAccount.id, role: 'owner' } },
        restrictedNpc,
        grantedAccount.id,
      )

      await body({
        app,
        slug,
        dm,
        granted: await login(app, 'granted'),
        ungranted: await login(app, 'ungranted'),
        guild: await make('organization', 'The Merchants Guild', 'public'),
        publicNpc: await make('npc', 'The Harbourmaster', 'public'),
        dmOnlyNpc: await make('npc', 'The Hollow Man', 'dm_only'),
        restrictedNpc,
      })
    } finally {
      await app.close()
    }
  })
}

async function login(app: FastifyInstance, username: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/login',
    payload: { username, password: PW },
  })
  return `cs_session=${res.cookies.find((x) => x.name === 'cs_session')!.value}`
}

interface View {
  id: string
  type: string
  label: string
  outgoing: boolean
  note: string
  other: { kind: string; id: string; name: string }
}

const list = async (h: Harness, cookie: string, kind: string, id: string): Promise<View[]> => {
  const res = await h.app.inject({
    method: 'GET',
    url: `/api/worlds/${h.slug}/entities/${kind}/${id}/relationships`,
    headers: { cookie },
  })
  expect(res.statusCode).toBe(200)
  return res.json().relationships as View[]
}

const relate = (
  h: Harness,
  cookie: string,
  from: { kind: string; id: string },
  payload: Record<string, unknown>,
): Promise<LightMyRequestResponse> => {
  const init: InjectOptions = {
    method: 'POST',
    url: `/api/worlds/${h.slug}/entities/${from.kind}/${from.id}/relationships`,
    headers: { cookie },
    payload,
  }
  return h.app.inject(init)
}

describe('asserting a relationship', () => {
  it('stores one row and renders it from BOTH ends', async () => {
    await withHarness(async (h) => {
      const created = await relate(
        h,
        h.dm,
        { kind: 'npc', id: h.publicNpc },
        { toId: h.guild, type: 'member_of' },
      )
      expect(created.statusCode).toBe(201)

      // Source page: the forward label, pointing at the guild.
      const onNpc = await list(h, h.dm, 'npc', h.publicNpc)
      expect(onNpc).toHaveLength(1)
      expect(onNpc[0]?.label).toBe('Member of')
      expect(onNpc[0]?.outgoing).toBe(true)
      expect(onNpc[0]?.other.name).toBe('The Merchants Guild')

      // Target page: the INVERSE label, pointing back — from the same row.
      const onGuild = await list(h, h.dm, 'organization', h.guild)
      expect(onGuild).toHaveLength(1)
      expect(onGuild[0]?.id).toBe(onNpc[0]?.id) // one row, two renderings
      expect(onGuild[0]?.label).toBe('Has member')
      expect(onGuild[0]?.outgoing).toBe(false)
      expect(onGuild[0]?.other.name).toBe('The Harbourmaster')
    })
  })

  it('reads a symmetric type the same way from either end', async () => {
    await withHarness(async (h) => {
      await relate(h, h.dm, { kind: 'npc', id: h.publicNpc }, { toId: h.guild, type: 'ally_of' })
      expect((await list(h, h.dm, 'npc', h.publicNpc))[0]?.label).toBe('Ally of')
      expect((await list(h, h.dm, 'organization', h.guild))[0]?.label).toBe('Ally of')
    })
  })

  it('carries an optional note', async () => {
    await withHarness(async (h) => {
      await relate(
        h,
        h.dm,
        { kind: 'npc', id: h.publicNpc },
        { toId: h.guild, type: 'serves', note: 'Reluctantly, and only since the fire.' },
      )
      expect((await list(h, h.dm, 'npc', h.publicNpc))[0]?.note).toBe(
        'Reluctantly, and only since the fire.',
      )
    })
  })

  it('carries a qualifier on a type that accepts one, and serves it back', async () => {
    await withHarness(async (h) => {
      const res = await relate(
        h,
        h.dm,
        { kind: 'npc', id: h.publicNpc },
        { toId: h.guild, type: 'speaks', qualifier: 'liturgical' },
      )
      expect(res.statusCode).toBe(201)
      const [rel] = await list(h, h.dm, 'npc', h.publicNpc)
      expect(rel).toMatchObject({ type: 'speaks', label: 'Speaks', qualifier: 'liturgical' })
    })
  })

  it('reports null rather than omitting the qualifier when there is none', async () => {
    await withHarness(async (h) => {
      await relate(h, h.dm, { kind: 'npc', id: h.publicNpc }, { toId: h.guild, type: 'serves' })
      // A present-and-null field rather than an absent one: the client type has it
      // as required, so a renderer never has to distinguish the two.
      expect((await list(h, h.dm, 'npc', h.publicNpc))[0]).toHaveProperty('qualifier', null)
    })
  })

  it("refuses a qualifier outside the type's vocabulary", async () => {
    await withHarness(async (h) => {
      const res = await relate(
        h,
        h.dm,
        { kind: 'npc', id: h.publicNpc },
        { toId: h.guild, type: 'speaks', qualifier: 'ancestral' },
      )
      expect(res.statusCode).toBe(400)
      expect(res.json().error.code).toBe('invalid_qualifier')
    })
  })

  it('refuses a qualifier on a type that defines none', async () => {
    // Otherwise the one column claiming to be a controlled vocabulary fills up
    // with values nothing can group by.
    await withHarness(async (h) => {
      const res = await relate(
        h,
        h.dm,
        { kind: 'npc', id: h.publicNpc },
        { toId: h.guild, type: 'ally_of', qualifier: 'native' },
      )
      expect(res.statusCode).toBe(400)
      expect(res.json().error.code).toBe('invalid_qualifier')
    })
  })

  it('allows two DIFFERENT relations between the same pair', async () => {
    // An NPC can lead an organization and be a member of it. The unique index is
    // on the pair PLUS the type, not on the pair.
    await withHarness(async (h) => {
      const from = { kind: 'npc', id: h.publicNpc }
      expect((await relate(h, h.dm, from, { toId: h.guild, type: 'member_of' })).statusCode).toBe(
        201,
      )
      expect((await relate(h, h.dm, from, { toId: h.guild, type: 'leads' })).statusCode).toBe(201)
      expect(await list(h, h.dm, 'npc', h.publicNpc)).toHaveLength(2)
    })
  })

  it('refuses the SAME relation twice with a 409 rather than a 500', async () => {
    await withHarness(async (h) => {
      const from = { kind: 'npc', id: h.publicNpc }
      await relate(h, h.dm, from, { toId: h.guild, type: 'member_of' })
      const again = await relate(h, h.dm, from, { toId: h.guild, type: 'member_of' })
      // A duplicate is a double-click, not an error to correct — and the unique
      // index would otherwise surface as an opaque failure naming an index.
      expect(again.statusCode).toBe(409)
      expect(again.json().error.code).toBe('duplicate_relationship')
      expect(await list(h, h.dm, 'npc', h.publicNpc)).toHaveLength(1)
    })
  })

  it('refuses relating an entity to itself', async () => {
    await withHarness(async (h) => {
      const res = await relate(
        h,
        h.dm,
        { kind: 'npc', id: h.publicNpc },
        { toId: h.publicNpc, type: 'ally_of' },
      )
      expect(res.statusCode).toBe(400)
      expect(res.json().error.code).toBe('self_relationship')
    })
  })

  it('refuses a type outside the vocabulary', async () => {
    await withHarness(async (h) => {
      const res = await relate(
        h,
        h.dm,
        { kind: 'npc', id: h.publicNpc },
        { toId: h.guild, type: 'owes_a_debt_to' },
      )
      expect(res.statusCode).toBe(400)
      expect(res.json().error.code).toBe('invalid_request')
    })
  })

  it('refuses a far end that does not exist', async () => {
    await withHarness(async (h) => {
      const res = await relate(
        h,
        h.dm,
        { kind: 'npc', id: h.publicNpc },
        { toId: 'no-such-entity', type: 'ally_of' },
      )
      expect(res.statusCode).toBe(404)
    })
  })

  it('404s a relationship asserted FROM an entity the actor cannot see', async () => {
    await withHarness(async (h) => {
      const res = await relate(
        h,
        h.ungranted,
        { kind: 'npc', id: h.dmOnlyNpc },
        { toId: h.guild, type: 'ally_of' },
      )
      expect(res.statusCode).toBe(404)
    })
  })

  it('refuses every relationship mutation for a player, server-side', async () => {
    await withHarness(async (h) => {
      const asPlayer = await relate(
        h,
        h.ungranted,
        { kind: 'npc', id: h.publicNpc },
        { toId: h.guild, type: 'ally_of' },
      )
      expect(asPlayer.statusCode).toBe(403)

      const created = await relate(
        h,
        h.dm,
        { kind: 'npc', id: h.publicNpc },
        { toId: h.guild, type: 'ally_of' },
      )
      const id = created.json().relationship.id as string
      const del = await h.app.inject({
        method: 'DELETE',
        url: `/api/worlds/${h.slug}/relationships/${id}`,
        headers: { cookie: h.ungranted },
      })
      expect(del.statusCode).toBe(403)
      expect(await list(h, h.dm, 'npc', h.publicNpc)).toHaveLength(1)
    })
  })
})

describe('removing a relationship', () => {
  it('removes it from both entities at once', async () => {
    // One row cannot be half-deleted — which is the whole reason it is one row.
    await withHarness(async (h) => {
      const created = await relate(
        h,
        h.dm,
        { kind: 'npc', id: h.publicNpc },
        { toId: h.guild, type: 'member_of' },
      )
      const id = created.json().relationship.id as string

      const res = await h.app.inject({
        method: 'DELETE',
        url: `/api/worlds/${h.slug}/relationships/${id}`,
        headers: { cookie: h.dm },
      })
      expect(res.statusCode).toBe(200)
      expect(await list(h, h.dm, 'npc', h.publicNpc)).toHaveLength(0)
      expect(await list(h, h.dm, 'organization', h.guild)).toHaveLength(0)
    })
  })

  it('404s an id that was never there', async () => {
    await withHarness(async (h) => {
      const res = await h.app.inject({
        method: 'DELETE',
        url: `/api/worlds/${h.slug}/relationships/no-such-id`,
        headers: { cookie: h.dm },
      })
      expect(res.statusCode).toBe(404)
    })
  })
})

describe('a relationship must never name an entity the reader cannot see', () => {
  it('withholds it in BOTH directions when the far end is dm_only', async () => {
    await withHarness(async (h) => {
      await relate(h, h.dm, { kind: 'npc', id: h.dmOnlyNpc }, { toId: h.guild, type: 'leads' })

      // The owner sees it from both sides.
      expect(await list(h, h.dm, 'organization', h.guild)).toHaveLength(1)
      expect(await list(h, h.dm, 'npc', h.dmOnlyNpc)).toHaveLength(1)

      // A player reading the VISIBLE guild is told nothing about who leads it.
      // Not a typed row with the name blanked: that would still report that the
      // guild stands in a named relation to something they cannot see.
      const asPlayer = await list(h, h.ungranted, 'organization', h.guild)
      expect(asPlayer).toHaveLength(0)
      expect(JSON.stringify(asPlayer)).not.toContain('Hollow Man')

      // …and the hidden entity's own page is a 404 for them regardless.
      const direct = await h.app.inject({
        method: 'GET',
        url: `/api/worlds/${h.slug}/entities/npc/${h.dmOnlyNpc}/relationships`,
        headers: { cookie: h.ungranted },
      })
      expect(direct.statusCode).toBe(404)
    })
  })

  it('withholds it until the far end is granted, then serves it', async () => {
    await withHarness(async (h) => {
      await relate(
        h,
        h.dm,
        { kind: 'npc', id: h.restrictedNpc },
        { toId: h.guild, type: 'member_of' },
      )

      // Same world, same guild, two players — one holds a grant for Silas Crow.
      expect(await list(h, h.ungranted, 'organization', h.guild)).toHaveLength(0)
      const forGranted = await list(h, h.granted, 'organization', h.guild)
      expect(forGranted).toHaveLength(1)
      expect(forGranted[0]?.other.name).toBe('Silas Crow')
      expect(forGranted[0]?.label).toBe('Has member')
    })
  })

  it('stops serving a relationship as soon as its far end is reclassified', async () => {
    await withHarness(async (h) => {
      await relate(h, h.dm, { kind: 'npc', id: h.publicNpc }, { toId: h.guild, type: 'member_of' })
      expect(await list(h, h.ungranted, 'organization', h.guild)).toHaveLength(1)

      await h.app.inject({
        method: 'PATCH',
        url: `/api/worlds/${h.slug}/entities/npc/${h.publicNpc}`,
        headers: { cookie: h.dm },
        payload: { visibility: 'dm_only' },
      })
      // Nothing about the RELATIONSHIP changed: visibility is read fresh on
      // every request rather than copied when the row was written.
      expect(await list(h, h.ungranted, 'organization', h.guild)).toHaveLength(0)
      expect(await list(h, h.dm, 'organization', h.guild)).toHaveLength(1)
    })
  })

  it('shows a player only the relationships whose far end they may see', async () => {
    await withHarness(async (h) => {
      // The guild relates to three NPCs at three visibilities.
      const from = { kind: 'organization', id: h.guild }
      await relate(h, h.dm, from, { toId: h.publicNpc, type: 'ally_of' })
      await relate(h, h.dm, from, { toId: h.dmOnlyNpc, type: 'enemy_of' })
      await relate(h, h.dm, from, { toId: h.restrictedNpc, type: 'rival_of' })

      expect(await list(h, h.dm, 'organization', h.guild)).toHaveLength(3)
      // The ungranted player sees only the public one…
      const ungranted = await list(h, h.ungranted, 'organization', h.guild)
      expect(ungranted.map((r) => r.other.name)).toEqual(['The Harbourmaster'])
      // …and the granted player sees that plus exactly the one they hold.
      const granted = await list(h, h.granted, 'organization', h.guild)
      expect(granted.map((r) => r.other.name).sort()).toEqual(['Silas Crow', 'The Harbourmaster'])
    })
  })
})

describe('relationships survive the operations that already exist around entities', () => {
  it('disappears when an endpoint is HARD-deleted, rather than dangling', async () => {
    await withHarness(async (h) => {
      await relate(h, h.dm, { kind: 'npc', id: h.publicNpc }, { toId: h.guild, type: 'member_of' })
      // The world-deletion cascade is what removes entities for real; a normal
      // DELETE is a soft delete, covered below.
      await h.app.inject({
        method: 'DELETE',
        url: `/api/worlds/${h.slug}/entities/npc/${h.publicNpc}`,
        headers: { cookie: h.dm },
      })
      // Soft-deleted: the seam stops resolving it, so the relationship stops
      // being served — without the row having to be found and cleaned up.
      expect(await list(h, h.dm, 'organization', h.guild)).toHaveLength(0)
    })
  })

  it('follows an entity through a change of kind', async () => {
    await withHarness(async (h) => {
      await relate(h, h.dm, { kind: 'npc', id: h.publicNpc }, { toId: h.guild, type: 'member_of' })
      await h.app.inject({
        method: 'POST',
        url: `/api/worlds/${h.slug}/entities/npc/${h.publicNpc}/change-kind`,
        headers: { cookie: h.dm },
        payload: { toKind: 'pc' },
      })
      // The id does not change, so the relationship does not either — and the
      // reported kind follows, so the link still points somewhere real.
      const onGuild = await list(h, h.dm, 'organization', h.guild)
      expect(onGuild).toHaveLength(1)
      expect(onGuild[0]?.other.kind).toBe('pc')
    })
  })

  it('travels with a world export', async () => {
    await withHarness(async (h) => {
      await relate(h, h.dm, { kind: 'npc', id: h.publicNpc }, { toId: h.guild, type: 'member_of' })
      const res = await h.app.inject({
        method: 'GET',
        url: `/api/worlds/${h.slug}/export`,
        headers: { cookie: h.dm },
      })
      expect(res.statusCode).toBe(200)
      // Canonical DM content, the same as a bracket in a body.
      expect(res.json().tables.entity_relationships).toHaveLength(1)
    })
  })
})

/**
 * The bracket → relationship round trip, over HTTP.
 *
 * The data layer proves reconciliation and the derived-visibility rule against a
 * real Postgres. What is asserted here is that the ROUTES run it: saving prose
 * creates the row, specifying it in place keeps it, and a bracket inside a
 * reveal produces a relationship only the reveal's audience can see.
 */
describe('brackets and relationships are one concept', () => {
  const patchEntity = (h: Harness, kind: string, id: string, payload: Record<string, unknown>) =>
    h.app.inject({
      method: 'PATCH',
      url: `/api/worlds/${h.slug}/entities/${kind}/${id}`,
      headers: { cookie: h.dm },
      payload,
    })

  it('creates a relationship on save, and retires it when the bracket goes', async () => {
    await withHarness(async (h) => {
      await patchEntity(h, 'npc', h.publicNpc, {
        description: 'Drinks at [[The Merchants Guild]].',
      })
      const after = await list(h, h.dm, 'npc', h.publicNpc)
      expect(after).toHaveLength(1)
      expect(after[0]?.type).toBe('related_to')
      expect(after[0]?.other.name).toBe('The Merchants Guild')

      await patchEntity(h, 'npc', h.publicNpc, { description: 'Drinks alone.' })
      expect(await list(h, h.dm, 'npc', h.publicNpc)).toEqual([])
    })
  })

  it('specifies a derived row in place, and it then survives the bracket going', async () => {
    await withHarness(async (h) => {
      await patchEntity(h, 'npc', h.publicNpc, {
        description: 'Drinks at [[The Merchants Guild]].',
      })
      const derived = (await list(h, h.dm, 'npc', h.publicNpc))[0]!

      const patched = await h.app.inject({
        method: 'PATCH',
        url: `/api/worlds/${h.slug}/relationships/${derived.id}`,
        headers: { cookie: h.dm },
        payload: { type: 'member_of', note: 'paid up' },
      })
      expect(patched.statusCode).toBe(200)

      await patchEntity(h, 'npc', h.publicNpc, { description: 'Drinks alone.' })
      const kept = await list(h, h.dm, 'npc', h.publicNpc)
      expect(kept).toHaveLength(1)
      expect(kept[0]?.type).toBe('member_of')
      expect(kept[0]?.note).toBe('paid up')
    })
  })

  it('refuses a player’s attempt to specify one, and 404s an unknown id', async () => {
    await withHarness(async (h) => {
      await patchEntity(h, 'npc', h.publicNpc, {
        description: 'Drinks at [[The Merchants Guild]].',
      })
      const derived = (await list(h, h.dm, 'npc', h.publicNpc))[0]!

      const refused = await h.app.inject({
        method: 'PATCH',
        url: `/api/worlds/${h.slug}/relationships/${derived.id}`,
        headers: { cookie: h.ungranted },
        payload: { type: 'member_of' },
      })
      expect(refused.statusCode).toBe(403)

      const missing = await h.app.inject({
        method: 'PATCH',
        url: `/api/worlds/${h.slug}/relationships/no-such-row`,
        headers: { cookie: h.dm },
        payload: { type: 'member_of' },
      })
      expect(missing.statusCode).toBe(404)
    })
  })

  it('keeps a reveal-sourced relationship for the reveal’s audience alone', async () => {
    await withHarness(async (h) => {
      // BOTH endpoints are public. The secret is not either of them — it is
      // that the two are connected at all.
      const reveal = await h.app.inject({
        method: 'POST',
        url: `/api/worlds/${h.slug}/entities/npc/${h.publicNpc}/passages`,
        headers: { cookie: h.dm },
        payload: {
          body: 'In truth he answers to [[The Merchants Guild]].',
          visibility: 'restricted',
        },
      })
      expect(reveal.statusCode).toBe(201)
      const passageId = reveal.json().passage.id as string

      expect(await list(h, h.dm, 'npc', h.publicNpc)).toHaveLength(1)
      expect(await list(h, h.ungranted, 'npc', h.publicNpc)).toEqual([])
      expect(await list(h, h.granted, 'npc', h.publicNpc)).toEqual([])

      // Granting the REVEAL reveals its relationship, with no write to the row.
      const grantedAccountId = (
        await h.app.inject({
          method: 'GET',
          url: `/api/worlds/${h.slug}/members`,
          headers: { cookie: h.dm },
        })
      )
        .json()
        .members.find((m: { username: string }) => m.username === 'granted').accountId
      await h.app.inject({
        method: 'POST',
        url: `/api/worlds/${h.slug}/passages/${passageId}/grants`,
        headers: { cookie: h.dm },
        payload: { accountId: grantedAccountId },
      })

      expect(await list(h, h.granted, 'npc', h.publicNpc)).toHaveLength(1)
      expect(await list(h, h.ungranted, 'npc', h.publicNpc)).toEqual([])
    })
  })

  it('retires a reveal’s relationships when the reveal is deleted', async () => {
    await withHarness(async (h) => {
      const reveal = await h.app.inject({
        method: 'POST',
        url: `/api/worlds/${h.slug}/entities/npc/${h.publicNpc}/passages`,
        headers: { cookie: h.dm },
        payload: { body: 'He answers to [[The Merchants Guild]].', visibility: 'dm_only' },
      })
      const passageId = reveal.json().passage.id as string
      expect(await list(h, h.dm, 'npc', h.publicNpc)).toHaveLength(1)

      // Passages are SOFT-deleted, so the foreign key's cascade never fires.
      // The delete route reconciles the parent, which is what retires the row.
      await h.app.inject({
        method: 'DELETE',
        url: `/api/worlds/${h.slug}/passages/${passageId}`,
        headers: { cookie: h.dm },
      })
      expect(await list(h, h.dm, 'npc', h.publicNpc)).toEqual([])
    })
  })

  it('never derives a row naming an entity the reader cannot see', async () => {
    await withHarness(async (h) => {
      // The passage filter is an ADDITIONAL condition, never a replacement for
      // both-endpoints-visible.
      await patchEntity(h, 'npc', h.publicNpc, { description: 'Fears [[The Hollow Man]].' })
      expect(await list(h, h.dm, 'npc', h.publicNpc)).toHaveLength(1)
      expect(await list(h, h.ungranted, 'npc', h.publicNpc)).toEqual([])
    })
  })
})
