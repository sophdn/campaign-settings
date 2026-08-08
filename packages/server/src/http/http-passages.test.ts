import type { FastifyInstance } from 'fastify'
import type { Pool } from 'pg'
import { describe, expect, it } from 'vitest'
import { createScryptAuth } from '../auth/service'
import { createPassage, grantPassageVisibility } from '../data/passages'
import { createDb } from '../db/kysely'
import { migrateToLatest } from '../db/migrator'
import { withTestDatabase } from '../db/test-database'
import { openFlags } from '../flags/config'
import { DEFAULT_LIMITS, type ResourceLimits } from '../tenancy/limits'
import { buildApp } from './app'

/**
 * The composed read, over HTTP.
 *
 * Every entity read carries two prose fields and they mean different things:
 * `description` is the raw base column the owner's editor round-trips, and
 * `body` is what this viewer may actually read. The tests that matter here are
 * the ones proving they stay distinct — collapsing them in either direction is
 * a data-loss bug in one case and a leak in the other.
 */

const SECRET = 'test-secret-test-secret-test-secret'
const PW = 'pw-123456'
const BASE = 'A fishmonger with ink-stained cuffs.'
const SECRET_REVEAL = 'He keeps the Ashen Hand ledger.'

interface Harness {
  app: FastifyInstance
  slug: string
  worldId: string
  dm: string
  dmId: string
  player: string
  playerId: string
  /** A second player, for proving one player cannot see another's proposal. */
  other: string
  otherId: string
  npcId: string
  db: ReturnType<typeof createDb>
}

async function withHarness(
  body: (h: Harness) => Promise<void>,
  limits?: Partial<ResourceLimits>,
  flagOverrides?: Partial<ReturnType<typeof openFlags>>,
): Promise<void> {
  await withTestDatabase(async (pool: Pool) => {
    const db = createDb(pool)
    await migrateToLatest(db)
    const auth = createScryptAuth(db)
    const app = buildApp({
      db,
      auth,
      cookieSecret: SECRET,
      cookieSecure: false,
      flags: { ...openFlags(), ...flagOverrides },
      ...(limits ? { limits: { ...DEFAULT_LIMITS, ...limits } } : {}),
    })
    await app.ready()
    try {
      const dmAccount = await auth.createAccount('dm', PW)
      const playerAccount = await auth.createAccount('player', PW)
      const otherAccount = await auth.createAccount('other', PW)
      const dm = await login(app, 'dm')
      const world = await app.inject({
        method: 'POST',
        url: '/api/worlds',
        headers: { cookie: dm },
        payload: { name: 'W' },
      })
      const slug = world.json().world.slug as string
      const worldId = world.json().world.id as string
      await app.inject({
        method: 'POST',
        url: `/api/worlds/${slug}/members`,
        headers: { cookie: dm },
        payload: { accountId: playerAccount.id },
      })
      const npc = await app.inject({
        method: 'POST',
        url: `/api/worlds/${slug}/entities/npc`,
        headers: { cookie: dm },
        payload: { name: 'Silas Crow', description: BASE, visibility: 'public' },
      })
      await body({
        app,
        slug,
        worldId,
        dm,
        dmId: dmAccount.id,
        player: await login(app, 'player'),
        playerId: playerAccount.id,
        other: await login(app, 'other'),
        otherId: otherAccount.id,
        npcId: npc.json().entity.id as string,
        db,
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

/** The owner context the data-layer helpers take, for seeding passages. */
function ownerCtx(h: Harness) {
  return { db: h.db, worldId: h.worldId, actor: { accountId: h.dmId, role: 'owner' as const } }
}

async function getEntity(h: Harness, cookie: string) {
  const res = await h.app.inject({
    method: 'GET',
    url: `/api/worlds/${h.slug}/entities/npc/${h.npcId}`,
    headers: { cookie },
  })
  return res.json() as { entity: Record<string, unknown> }
}

/** Passages are a sub-resource with their own route, like media and relationships. */
async function getPassages(
  h: Harness,
  cookie: string,
): Promise<ReadonlyArray<Record<string, unknown>>> {
  const res = await h.app.inject({
    method: 'GET',
    url: `/api/worlds/${h.slug}/entities/npc/${h.npcId}/passages`,
    headers: { cookie },
  })
  return res.json().passages as ReadonlyArray<Record<string, unknown>>
}

describe('entity reads compose prose per viewer', () => {
  it('returns raw description AND composed body, and they differ per viewer', async () => {
    await withHarness(async (h) => {
      await createPassage(
        ownerCtx(h),
        { entityId: h.npcId, body: SECRET_REVEAL, visibility: 'dm_only' },
        h.dmId,
      )

      const asOwner = await getEntity(h, h.dm)
      expect(asOwner.entity.description).toBe(BASE)
      expect(asOwner.entity.body).toContain(BASE)
      expect(asOwner.entity.body).toContain(SECRET_REVEAL)
      expect(await getPassages(h, h.dm)).toHaveLength(1)

      const asPlayer = await getEntity(h, h.player)
      // the base column is public prose, so it still comes back...
      expect(asPlayer.entity.description).toBe(BASE)
      // ...but the composed body carries nothing they may not read
      expect(asPlayer.entity.body).toBe(BASE)
      expect(JSON.stringify(asPlayer)).not.toContain(SECRET_REVEAL)
      expect(await getPassages(h, h.player)).toHaveLength(0)
    })
  })

  it('composes the list route too, so a list and a detail page agree', async () => {
    await withHarness(async (h) => {
      await createPassage(
        ownerCtx(h),
        { entityId: h.npcId, body: SECRET_REVEAL, visibility: 'dm_only' },
        h.dmId,
      )

      const listed = async (cookie: string) => {
        const res = await h.app.inject({
          method: 'GET',
          url: `/api/worlds/${h.slug}/entities/npc`,
          headers: { cookie },
        })
        return (res.json().entities as Array<Record<string, unknown>>).find(
          (e) => e.id === h.npcId,
        )!
      }

      expect((await listed(h.dm)).body).toContain(SECRET_REVEAL)
      expect((await listed(h.player)).body).toBe(BASE)
      expect((await listed(h.dm)).body).toBe((await getEntity(h, h.dm)).entity.body)
    })
  })

  it('a restricted passage reaches only the granted player', async () => {
    await withHarness(async (h) => {
      const p = await createPassage(
        ownerCtx(h),
        { entityId: h.npcId, body: SECRET_REVEAL, visibility: 'restricted' },
        h.dmId,
      )
      expect((await getEntity(h, h.player)).entity.body).toBe(BASE)

      await grantPassageVisibility(ownerCtx(h), p.id, h.playerId)
      expect((await getEntity(h, h.player)).entity.body).toContain(SECRET_REVEAL)
    })
  })

  /**
   * The data-loss case. The owner's editor round-trips `description`, and their
   * `body` contains every passage they can see. If the editor were ever pointed
   * at `body`, the next save would fold all of it into the base column — where
   * it would become permanently public prose, and the passages would still be
   * there, now duplicated. This asserts the round trip stays clean.
   */
  it('an owner saving the description does not absorb passage text into it', async () => {
    await withHarness(async (h) => {
      await createPassage(
        ownerCtx(h),
        { entityId: h.npcId, body: SECRET_REVEAL, visibility: 'dm_only' },
        h.dmId,
      )

      const before = await getEntity(h, h.dm)
      expect(before.entity.body).toContain(SECRET_REVEAL)

      // save back exactly what the editor was given
      await h.app.inject({
        method: 'PATCH',
        url: `/api/worlds/${h.slug}/entities/npc/${h.npcId}`,
        headers: { cookie: h.dm },
        payload: { description: before.entity.description },
      })

      const after = await getEntity(h, h.dm)
      expect(after.entity.description).toBe(BASE)
      expect(await getPassages(h, h.dm)).toHaveLength(1)
      // the reveal appears ONCE — in the passage, not also in the base column
      expect((after.entity.body as string).split(SECRET_REVEAL)).toHaveLength(2)

      // and the player still cannot read it
      expect((await getEntity(h, h.player)).entity.body).toBe(BASE)
    })
  })
})

/**
 * The write surface. Every route here is owner-only, and the assertions that
 * matter are the ones proving a PLAYER is refused server-side — the SPA not
 * rendering a button is a courtesy, not the enforcement.
 */
describe('passage routes', () => {
  const create = (h: Harness, cookie: string, payload: Record<string, unknown>) =>
    h.app.inject({
      method: 'POST',
      url: `/api/worlds/${h.slug}/entities/npc/${h.npcId}/passages`,
      headers: { cookie },
      payload,
    })

  it('an owner creates, edits, reorders and deletes', async () => {
    await withHarness(async (h) => {
      const made = await create(h, h.dm, { body: 'first', visibility: 'public' })
      expect(made.statusCode).toBe(201)
      const id = made.json().passage.id as string

      const patched = await h.app.inject({
        method: 'PATCH',
        url: `/api/worlds/${h.slug}/passages/${id}`,
        headers: { cookie: h.dm },
        payload: { body: 'second', position: 4 },
      })
      expect(patched.statusCode).toBe(200)
      expect(patched.json().passage).toMatchObject({ body: 'second', position: 4 })

      const gone = await h.app.inject({
        method: 'DELETE',
        url: `/api/worlds/${h.slug}/passages/${id}`,
        headers: { cookie: h.dm },
      })
      expect(gone.statusCode).toBe(200)
      expect(await getPassages(h, h.dm)).toHaveLength(0)
    })
  })

  it('omitting visibility fails closed at dm_only rather than defaulting open', async () => {
    await withHarness(async (h) => {
      const made = await create(h, h.dm, { body: 'unspecified' })
      expect(made.json().passage.visibility).toBe('dm_only')
      expect(await getPassages(h, h.player)).toHaveLength(0)
    })
  })

  it('refuses status and author_id from the client, whatever the body says', async () => {
    await withHarness(async (h) => {
      // A client that could set either could publish its own proposal or write
      // in someone else's name. zod strips them; assert rather than assume.
      const made = await create(h, h.dm, {
        body: 'x',
        visibility: 'public',
        status: 'proposed',
        author_id: h.playerId,
      })
      expect(made.json().passage.status).toBe('published')
      expect(made.json().passage.author_id).toBe(h.dmId)
    })
  })

  it('refuses a player every write, and grant management too', async () => {
    await withHarness(async (h) => {
      const id = (await create(h, h.dm, { body: 'owned', visibility: 'public' })).json().passage
        .id as string

      expect((await create(h, h.player, { body: 'mine' })).statusCode).toBe(403)
      const asPlayer = (method: 'PATCH' | 'DELETE', url: string, payload?: unknown) =>
        h.app.inject({
          method,
          url,
          headers: { cookie: h.player },
          ...(payload ? { payload } : {}),
        })

      expect(
        (await asPlayer('PATCH', `/api/worlds/${h.slug}/passages/${id}`, { body: 'hijack' }))
          .statusCode,
      ).toBe(403)
      expect((await asPlayer('DELETE', `/api/worlds/${h.slug}/passages/${id}`)).statusCode).toBe(
        403,
      )
      expect(
        (
          await h.app.inject({
            method: 'POST',
            url: `/api/worlds/${h.slug}/passages/${id}/grants`,
            headers: { cookie: h.player },
            payload: { accountId: h.playerId },
          })
        ).statusCode,
      ).toBe(403)
      expect(
        (
          await h.app.inject({
            method: 'GET',
            url: `/api/worlds/${h.slug}/passages/${id}/grants`,
            headers: { cookie: h.player },
          })
        ).statusCode,
      ).toBe(403)

      // and nothing the player attempted took effect
      expect((await getPassages(h, h.dm))[0]).toMatchObject({ body: 'owned' })
    })
  })

  it('grants and revokes through the routes, and the composed body follows', async () => {
    await withHarness(async (h) => {
      const id = (await create(h, h.dm, { body: SECRET_REVEAL, visibility: 'restricted' })).json()
        .passage.id as string
      const grantUrl = `/api/worlds/${h.slug}/passages/${id}/grants`

      expect((await getEntity(h, h.player)).entity.body).toBe(BASE)
      await h.app.inject({
        method: 'POST',
        url: grantUrl,
        headers: { cookie: h.dm },
        payload: { accountId: h.playerId },
      })
      expect(
        (await h.app.inject({ method: 'GET', url: grantUrl, headers: { cookie: h.dm } })).json()
          .accountIds,
      ).toEqual([h.playerId])
      expect((await getEntity(h, h.player)).entity.body).toContain(SECRET_REVEAL)

      await h.app.inject({
        method: 'DELETE',
        url: `${grantUrl}/${h.playerId}`,
        headers: { cookie: h.dm },
      })
      expect((await getEntity(h, h.player)).entity.body).toBe(BASE)
    })
  })

  it('404s a passage in another world rather than leaking that it exists', async () => {
    await withHarness(async (h) => {
      const res = await h.app.inject({
        method: 'PATCH',
        url: `/api/worlds/${h.slug}/passages/no-such-passage`,
        headers: { cookie: h.dm },
        payload: { body: 'x' },
      })
      expect(res.statusCode).toBe(404)
    })
  })

  it('refuses a passage on an entity the caller cannot see', async () => {
    await withHarness(async (h) => {
      const secretNpc = await h.app.inject({
        method: 'POST',
        url: `/api/worlds/${h.slug}/entities/npc`,
        headers: { cookie: h.dm },
        payload: { name: 'The Hollow Man', visibility: 'dm_only' },
      })
      const res = await h.app.inject({
        method: 'POST',
        url: `/api/worlds/${h.slug}/entities/npc/${secretNpc.json().entity.id}/passages`,
        headers: { cookie: h.player },
        payload: { body: 'x' },
      })
      // 404, not 403 — the player may not learn the entity exists
      expect(res.statusCode).toBe(404)
    })
  })

  it('enforces the per-entity count cap, counting what is already there', async () => {
    await withHarness(
      async (h) => {
        expect((await create(h, h.dm, { body: 'one' })).statusCode).toBe(201)
        expect((await create(h, h.dm, { body: 'two' })).statusCode).toBe(201)

        const third = await create(h, h.dm, { body: 'three' })
        expect(third.statusCode).toBe(409)
        expect(third.json().error.code).toBe('limit_reached')
        expect(third.json().error.message).toMatch(/maximum of 2 passages/)

        // the ceiling is per ENTITY, so a different entity still has room
        const other = await h.app.inject({
          method: 'POST',
          url: `/api/worlds/${h.slug}/entities/npc`,
          headers: { cookie: h.dm },
          payload: { name: 'Someone Else', visibility: 'public' },
        })
        const onOther = await h.app.inject({
          method: 'POST',
          url: `/api/worlds/${h.slug}/entities/npc/${other.json().entity.id}/passages`,
          headers: { cookie: h.dm },
          payload: { body: 'room here' },
        })
        expect(onOther.statusCode).toBe(201)
      },
      { passagesPerEntity: 2 },
    )
  })

  it('enforces the body length cap', async () => {
    await withHarness(async (h) => {
      const tooLong = await create(h, h.dm, { body: 'x'.repeat(20_001) })
      expect(tooLong.statusCode).toBe(409)
      expect(tooLong.json().error.code).toBe('limit_reached')
      expect(tooLong.json().error.message).toMatch(/20001 characters/)
      // the refusal says what the ceiling IS, so the DM knows what to trim to
      expect(tooLong.json().error.message).toMatch(/maximum is 20000/)
    })
  })
})

describe('passage routes — the remaining refusals', () => {
  it('404s a grant against a passage that does not exist', async () => {
    await withHarness(async (h) => {
      const res = await h.app.inject({
        method: 'POST',
        url: `/api/worlds/${h.slug}/passages/no-such-passage/grants`,
        headers: { cookie: h.dm },
        payload: { accountId: h.playerId },
      })
      expect(res.statusCode).toBe(404)
    })
  })

  it('404s a delete against a passage that does not exist', async () => {
    await withHarness(async (h) => {
      const res = await h.app.inject({
        method: 'DELETE',
        url: `/api/worlds/${h.slug}/passages/no-such-passage`,
        headers: { cookie: h.dm },
      })
      expect(res.statusCode).toBe(404)
    })
  })

  it('404s listing the passages of an entity the caller cannot see', async () => {
    await withHarness(async (h) => {
      const secret = await h.app.inject({
        method: 'POST',
        url: `/api/worlds/${h.slug}/entities/npc`,
        headers: { cookie: h.dm },
        payload: { name: 'The Hollow Man', visibility: 'dm_only' },
      })
      const res = await h.app.inject({
        method: 'GET',
        url: `/api/worlds/${h.slug}/entities/npc/${secret.json().entity.id}/passages`,
        headers: { cookie: h.player },
      })
      expect(res.statusCode).toBe(404)
    })
  })

  /**
   * Sessions ride the same entity routes through ENTITY_REPOS but have no
   * `description` column and cannot own a passage — entity_passages.entity_id
   * is foreign-keyed to `entities`. Composing one used to throw a 500.
   */
  it('serves sessions through the shared entity routes without composing them', async () => {
    await withHarness(async (h) => {
      const made = await h.app.inject({
        method: 'POST',
        url: `/api/worlds/${h.slug}/entities/session`,
        headers: { cookie: h.dm },
        payload: { name: 'Session One' },
      })
      expect(made.statusCode).toBe(201)

      const listed = await h.app.inject({
        method: 'GET',
        url: `/api/worlds/${h.slug}/entities/session`,
        headers: { cookie: h.dm },
      })
      expect(listed.statusCode).toBe(200)
      expect(listed.json().entities).toHaveLength(1)
      // no `body` is invented for something that has no prose to compose
      expect(listed.json().entities[0]).not.toHaveProperty('body')
    })
  })
})

/**
 * Player proposals — the one hole in owner-only writes.
 *
 * Everywhere else `assertContentWrite` refuses a player unconditionally, and
 * that being exceptionless is load-bearing. These tests exist to pin the shape
 * of the exception: what a player CAN do here, and that they can do nothing
 * else. The positive-path test is one; the rest are refusals.
 */
describe('player-proposed passages', () => {
  const propose = (h: Harness, cookie: string, payload: Record<string, unknown>) =>
    h.app.inject({
      method: 'POST',
      url: `/api/worlds/${h.slug}/entities/npc/${h.npcId}/propose`,
      headers: { cookie },
      payload,
    })

  it('a player proposes, and only they and the owner can see it', async () => {
    await withHarness(async (h) => {
      const made = await propose(h, h.player, { body: 'I think he runs the ledger.' })
      expect(made.statusCode).toBe(201)
      expect(made.json().passage).toMatchObject({
        status: 'proposed',
        visibility: 'restricted',
        author_id: h.playerId,
      })

      // the author reads back what they wrote, composed into their own body
      expect((await getEntity(h, h.player)).entity.body).toContain('runs the ledger')
      // and the owner sees it for review
      expect(await getPassages(h, h.dm)).toHaveLength(1)
    })
  })

  it('a SECOND player cannot see another player’s pending proposal', async () => {
    await withHarness(async (h) => {
      const other = await h.app.inject({
        method: 'POST',
        url: `/api/worlds/${h.slug}/members`,
        headers: { cookie: h.dm },
        payload: { accountId: h.otherId },
      })
      expect(other.statusCode).toBeLessThan(300)
      await propose(h, h.player, { body: 'MY PRIVATE GUESS' })

      const asOther = await getEntity(h, h.other)
      expect(asOther.entity.body).toBe(BASE)
      expect(JSON.stringify(asOther)).not.toContain('MY PRIVATE GUESS')
      expect(await getPassages(h, h.other)).toHaveLength(0)
    })
  })

  /**
   * The load-bearing one. A client that could set any of these could publish
   * its own proposal, write in someone else's name, or place itself in the
   * middle of the DM's prose. Sending them all and asserting each is ignored
   * is the proof — not merely omitting them.
   */
  it('ignores every field a player might send to widen their own proposal', async () => {
    await withHarness(async (h) => {
      const made = await propose(h, h.player, {
        body: 'sneaky',
        status: 'published',
        visibility: 'public',
        author_id: h.dmId,
        position: 0,
        entity_id: 'somewhere-else',
        world_id: 'another-world',
      })
      expect(made.statusCode).toBe(201)
      expect(made.json().passage).toMatchObject({
        status: 'proposed',
        visibility: 'restricted',
        author_id: h.playerId,
        entity_id: h.npcId,
      })
      // position is computed, so it landed at the END rather than at the top
      expect(made.json().passage.position).toBeGreaterThan(0)
    })
  })

  it('refuses a proposal against an entity the player cannot see', async () => {
    await withHarness(async (h) => {
      const secret = await h.app.inject({
        method: 'POST',
        url: `/api/worlds/${h.slug}/entities/npc`,
        headers: { cookie: h.dm },
        payload: { name: 'The Hollow Man', visibility: 'dm_only' },
      })
      const res = await h.app.inject({
        method: 'POST',
        url: `/api/worlds/${h.slug}/entities/npc/${secret.json().entity.id}/propose`,
        headers: { cookie: h.player },
        payload: { body: 'x' },
      })
      // 404, not 403 — the refusal must not confirm the entity exists
      expect(res.statusCode).toBe(404)
    })
  })

  it('refuses a player every action on a proposal except making one', async () => {
    await withHarness(async (h) => {
      const mine = (await propose(h, h.player, { body: 'mine' })).json().passage.id as string
      const call = (method: 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) =>
        h.app.inject({
          method,
          url: `/api/worlds/${h.slug}${url}`,
          headers: { cookie: h.player },
          ...(payload ? { payload } : {}),
        })

      // cannot accept their own, nor reject, nor edit, nor delete, nor re-grant
      expect(
        (await call('POST', `/passages/${mine}/accept`, { visibility: 'public' })).statusCode,
      ).toBe(403)
      expect((await call('POST', `/passages/${mine}/reject`)).statusCode).toBe(403)
      expect((await call('PATCH', `/passages/${mine}`, { body: 'edited' })).statusCode).toBe(403)
      expect((await call('DELETE', `/passages/${mine}`)).statusCode).toBe(403)
      expect(
        (await call('POST', `/passages/${mine}/grants`, { accountId: h.playerId })).statusCode,
      ).toBe(403)

      // and it is still exactly as proposed
      const still = (await getPassages(h, h.dm))[0]
      expect(still).toMatchObject({ body: 'mine', status: 'proposed' })
    })
  })

  it('the owner accepts at a visibility THEY choose, and the self-grant goes', async () => {
    await withHarness(async (h) => {
      const id = (await propose(h, h.player, { body: 'ACCEPTED TEXT' })).json().passage.id as string

      const accepted = await h.app.inject({
        method: 'POST',
        url: `/api/worlds/${h.slug}/passages/${id}/accept`,
        headers: { cookie: h.dm },
        payload: { visibility: 'public' },
      })
      expect(accepted.statusCode).toBe(200)
      expect(accepted.json().passage).toMatchObject({ status: 'published', visibility: 'public' })

      // the self-grant is gone: access now comes from `public`, like anyone's.
      // Leaving it would make every accepted proposal quietly restricted too.
      const grants = await h.app.inject({
        method: 'GET',
        url: `/api/worlds/${h.slug}/passages/${id}/grants`,
        headers: { cookie: h.dm },
      })
      expect(grants.json().accountIds).toEqual([])
      expect((await getEntity(h, h.player)).entity.body).toContain('ACCEPTED TEXT')
    })
  })

  it('an accepted proposal can be published dm_only, hiding it from its own author', async () => {
    await withHarness(async (h) => {
      const id = (await propose(h, h.player, { body: 'FOR THE GM ONLY' })).json().passage
        .id as string
      await h.app.inject({
        method: 'POST',
        url: `/api/worlds/${h.slug}/passages/${id}/accept`,
        headers: { cookie: h.dm },
        payload: { visibility: 'dm_only' },
      })
      // The DM took the idea but not the telling of it. The author loses sight
      // of their own words, which is correct: it is the DM's world.
      expect((await getEntity(h, h.player)).entity.body).toBe(BASE)
      expect((await getEntity(h, h.dm)).entity.body).toContain('FOR THE GM ONLY')
    })
  })

  it('rejecting soft-deletes it, so nobody sees it and the record survives', async () => {
    await withHarness(async (h) => {
      const id = (await propose(h, h.player, { body: 'DECLINED' })).json().passage.id as string
      const res = await h.app.inject({
        method: 'POST',
        url: `/api/worlds/${h.slug}/passages/${id}/reject`,
        headers: { cookie: h.dm },
      })
      expect(res.statusCode).toBe(200)
      expect((await getEntity(h, h.player)).entity.body).toBe(BASE)
      expect(await getPassages(h, h.dm)).toHaveLength(0)
    })
  })

  it('accept and reject apply only to proposals, not to the DM’s own passages', async () => {
    await withHarness(async (h) => {
      const published = (
        await h.app.inject({
          method: 'POST',
          url: `/api/worlds/${h.slug}/entities/npc/${h.npcId}/passages`,
          headers: { cookie: h.dm },
          payload: { body: 'already mine', visibility: 'public' },
        })
      ).json().passage.id as string

      for (const action of ['accept', 'reject']) {
        const res = await h.app.inject({
          method: 'POST',
          url: `/api/worlds/${h.slug}/passages/${published}/${action}`,
          headers: { cookie: h.dm },
          payload: { visibility: 'public' },
        })
        expect(res.statusCode).toBe(404)
      }
    })
  })

  it('caps how many proposals one player may have awaiting review', async () => {
    await withHarness(
      async (h) => {
        expect((await propose(h, h.player, { body: 'one' })).statusCode).toBe(201)
        expect((await propose(h, h.player, { body: 'two' })).statusCode).toBe(201)

        const third = await propose(h, h.player, { body: 'three' })
        expect(third.statusCode).toBe(409)
        expect(third.json().error.message).toMatch(/awaiting review/)

        // accepting one frees a slot, because the cap counts PENDING only
        const id = (await getPassages(h, h.dm))[0]!.id as string
        await h.app.inject({
          method: 'POST',
          url: `/api/worlds/${h.slug}/passages/${id}/accept`,
          headers: { cookie: h.dm },
          payload: { visibility: 'public' },
        })
        expect((await propose(h, h.player, { body: 'three, again' })).statusCode).toBe(201)
      },
      { pendingProposalsPerAuthor: 2 },
    )
  })

  it('refuses to propose at all when the suggestions surface is gated off', async () => {
    await withHarness(
      async (h) => {
        const res = await propose(h, h.player, { body: 'blocked' })
        expect(res.statusCode).toBe(403)
      },
      undefined,
      { suggestionsEnabled: false },
    )
  })
})
