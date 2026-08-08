import type { FastifyInstance, LightMyRequestResponse } from 'fastify'
import type { Pool } from 'pg'
import { describe, expect, it } from 'vitest'
import { createScryptAuth } from '../auth/service'
import { createDb } from '../db/kysely'
import { migrateToLatest } from '../db/migrator'
import { openFlags } from '../flags/config'
import { withTestDatabase } from '../db/test-database'
import { buildApp } from './app'

const SECRET = 'test-secret-test-secret-test-secret'

async function login(app: FastifyInstance, username: string, password: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/login',
    payload: { username, password },
  })
  const c = res.cookies.find((x) => x.name === 'cs_session')
  if (!c) throw new Error(`no session cookie for ${username}`)
  return `cs_session=${c.value}`
}

/**
 * A world owned by `dm`, with `player` and `other` as members, an `outsider` in
 * nothing, one restricted npc granted to `player`, and one note and one
 * character owned by `player`.
 */
async function setup(pool: Pool) {
  const db = createDb(pool)
  await migrateToLatest(db)
  const auth = createScryptAuth(db)
  const app = buildApp({
    db,
    auth,
    cookieSecret: SECRET,
    cookieSecure: false,
    // This suite's subject is the flow, not the access gate — flags ship
    // fail-closed, and restating the policy in every setup is how setups
    // drift from the real defaults. The gate has its own suite.
    flags: openFlags(),
  })
  await app.ready()

  const dmAccount = await auth.createAccount('dm', 'pw-123456')
  const playerAccount = await auth.createAccount('player', 'pw-123456')
  const otherAccount = await auth.createAccount('other', 'pw-123456')
  await auth.createAccount('outsider', 'pw-123456')

  const dm = await login(app, 'dm', 'pw-123456')
  const player = await login(app, 'player', 'pw-123456')
  const other = await login(app, 'other', 'pw-123456')
  const outsider = await login(app, 'outsider', 'pw-123456')

  const created = await app.inject({
    method: 'POST',
    url: '/api/worlds',
    headers: { cookie: dm },
    payload: { name: 'W' },
  })
  const worldId = created.json().world.slug as string
  const base = `/api/worlds/${worldId}`
  for (const id of [playerAccount.id, otherAccount.id]) {
    await app.inject({
      method: 'POST',
      url: `${base}/members`,
      headers: { cookie: dm },
      payload: { accountId: id },
    })
  }

  const npc = await app.inject({
    method: 'POST',
    url: `${base}/entities/npc`,
    headers: { cookie: dm },
    payload: { name: 'Hidden', visibility: 'restricted' },
  })
  const entityId = npc.json().entity.id as string
  await app.inject({
    method: 'POST',
    url: `${base}/entities/npc/${entityId}/grants`,
    headers: { cookie: dm },
    payload: { accountId: playerAccount.id },
  })
  await app.inject({
    method: 'POST',
    url: `${base}/notes`,
    headers: { cookie: player },
    payload: { body: 'my private note' },
  })
  await app.inject({
    method: 'POST',
    url: `${base}/characters`,
    headers: { cookie: player },
    payload: { name: 'My PC' },
  })

  return {
    app,
    db,
    base,
    worldId,
    dm,
    player,
    other,
    outsider,
    dmId: dmAccount.id,
    playerId: playerAccount.id,
    otherId: otherAccount.id,
    entityId,
  }
}

/** The role each account holds in the world, straight from the DB. */
async function roles(
  db: Awaited<ReturnType<typeof setup>>['db'],
  worldSlug: string,
): Promise<Record<string, string>> {
  const rows = await db
    .selectFrom('world_members')
    .innerJoin('worlds', 'worlds.id', 'world_members.world_id')
    .innerJoin('accounts', 'accounts.id', 'world_members.account_id')
    .where('worlds.slug', '=', worldSlug)
    .select(['accounts.username as username', 'world_members.role as role'])
    .execute()
  return Object.fromEntries(rows.map((r) => [r.username, r.role]))
}

describe('renaming a world', () => {
  it('moves the world to its new address, and the old one stops resolving', async () => {
    await withTestDatabase(async (pool) => {
      const { app, base, dm } = await setup(pool)

      const res = await app.inject({
        method: 'PATCH',
        url: base,
        headers: { cookie: dm },
        payload: { name: 'VTM Detroit' },
      })
      expect(res.statusCode).toBe(200)
      expect(res.json().world).toMatchObject({ name: 'VTM Detroit', slug: 'vtm-detroit' })

      // The response is the caller's only way to find the world again: the URL
      // they just used is dead.
      const atNew = await app.inject({
        method: 'GET',
        url: '/api/worlds/vtm-detroit',
        headers: { cookie: dm },
      })
      expect(atNew.statusCode).toBe(200)
      expect(atNew.json().world.name).toBe('VTM Detroit')
      const atOld = await app.inject({ method: 'GET', url: base, headers: { cookie: dm } })
      expect(atOld.statusCode).toBe(403)
    })
  })

  it('carries the world’s people and content across with it', async () => {
    await withTestDatabase(async (pool) => {
      const { app, base, dm, playerId } = await setup(pool)

      const invited = await app.inject({
        method: 'POST',
        url: `${base}/invitations`,
        headers: { cookie: dm },
        payload: {},
      })
      expect(invited.statusCode).toBe(201)

      await app.inject({
        method: 'PATCH',
        url: base,
        headers: { cookie: dm },
        payload: { name: 'VTM Detroit' },
      })
      const moved = '/api/worlds/vtm-detroit'

      // Everything hangs off the world id, which a rename never touches — but
      // the slug is a foreign key in people's heads, so this is asserted.
      const members = await app.inject({
        method: 'GET',
        url: `${moved}/members`,
        headers: { cookie: dm },
      })
      expect(members.json().members.map((m: { accountId: string }) => m.accountId)).toContain(
        playerId,
      )
      const wiki = await app.inject({
        method: 'GET',
        url: `${moved}/wiki`,
        headers: { cookie: dm },
      })
      expect(wiki.json().entries).toHaveLength(1)
      const invitations = await app.inject({
        method: 'GET',
        url: `${moved}/invitations`,
        headers: { cookie: dm },
      })
      expect(invitations.json().invitations).toHaveLength(1)
    })
  })

  it('refuses a member and an outsider server-side, not merely in the UI', async () => {
    await withTestDatabase(async (pool) => {
      const { app, base, player, outsider, dm } = await setup(pool)

      for (const cookie of [player, outsider]) {
        const res = await app.inject({
          method: 'PATCH',
          url: base,
          headers: { cookie },
          payload: { name: 'Mine Now' },
        })
        expect(res.statusCode).toBe(403)
      }
      const still = await app.inject({ method: 'GET', url: base, headers: { cookie: dm } })
      expect(still.json().world.name).toBe('W')
    })
  })

  it('rejects a blank, whitespace-only, or absurdly long name', async () => {
    await withTestDatabase(async (pool) => {
      const { app, base, dm } = await setup(pool)

      for (const name of ['', '   ', 'x'.repeat(201)]) {
        const res = await app.inject({
          method: 'PATCH',
          url: base,
          headers: { cookie: dm },
          payload: { name },
        })
        expect(res.statusCode).toBe(400)
      }
      // A world named ' ' would slugify to the meaningless 'world'; it is
      // refused rather than stored.
      const still = await app.inject({ method: 'GET', url: base, headers: { cookie: dm } })
      expect(still.json().world.name).toBe('W')
    })
  })
})

describe('leaving a world', () => {
  it('lets a player leave and lose access, without the owner involved', async () => {
    await withTestDatabase(async (pool) => {
      const { app, base, player } = await setup(pool)

      const left = await app.inject({
        method: 'POST',
        url: `${base}/leave`,
        headers: { cookie: player },
      })
      expect(left.statusCode).toBe(200)

      // the world is gone from their list, and the world itself is unreachable
      const worlds = await app.inject({
        method: 'GET',
        url: '/api/worlds',
        headers: { cookie: player },
      })
      expect(worlds.json().worlds).toEqual([])
      const read = await app.inject({ method: 'GET', url: base, headers: { cookie: player } })
      expect(read.statusCode).toBe(403)
    })
  })

  it('deletes the leaver’s notes, characters, and entity grants', async () => {
    await withTestDatabase(async (pool) => {
      const { app, db, base, player, playerId, entityId, worldId } = await setup(pool)

      await app.inject({ method: 'POST', url: `${base}/leave`, headers: { cookie: player } })

      const notes = await db
        .selectFrom('player_notes')
        .select('id')
        .where('author_id', '=', playerId)
        .execute()
      const chars = await db
        .selectFrom('player_characters')
        .select('id')
        .where('owner_id', '=', playerId)
        .execute()
      const grants = await db
        .selectFrom('entity_visibility')
        .select('account_id')
        .where('entity_id', '=', entityId)
        .execute()
      expect(notes).toEqual([])
      expect(chars).toEqual([])
      expect(grants).toEqual([])
      expect(Object.keys(await roles(db, worldId))).toEqual(expect.not.arrayContaining(['player']))
    })
  })

  it('refuses the OWNER, naming the two real alternatives', async () => {
    await withTestDatabase(async (pool) => {
      const { app, base, dm } = await setup(pool)

      const res = await app.inject({
        method: 'POST',
        url: `${base}/leave`,
        headers: { cookie: dm },
      })

      expect(res.statusCode).toBe(409)
      expect(res.json().error.code).toBe('owner_cannot_leave')
      expect(res.json().error.message).toMatch(/transfer ownership|delete the world/i)
    })
  })

  it('refuses a non-member', async () => {
    await withTestDatabase(async (pool) => {
      const { app, base, outsider } = await setup(pool)
      const res = await app.inject({
        method: 'POST',
        url: `${base}/leave`,
        headers: { cookie: outsider },
      })
      expect(res.statusCode).toBe(403)
    })
  })

  /** The bug this task also closes: removal used to leave grants behind. */
  it('owner-initiated removal purges grants too, so a re-added player does not regain access', async () => {
    await withTestDatabase(async (pool) => {
      const { app, base, dm, player, playerId, entityId } = await setup(pool)
      const sees = async (): Promise<number> =>
        (
          await app.inject({
            method: 'GET',
            url: `${base}/entities/npc/${entityId}`,
            headers: { cookie: player },
          })
        ).statusCode
      expect(await sees()).toBe(200)

      await app.inject({
        method: 'DELETE',
        url: `${base}/members/${playerId}`,
        headers: { cookie: dm },
      })
      await app.inject({
        method: 'POST',
        url: `${base}/members`,
        headers: { cookie: dm },
        payload: { accountId: playerId },
      })

      // re-added, but the old grant did not come back with them
      expect(await sees()).toBe(404)
    })
  })
})

describe('ownership transfer', () => {
  const offer = (
    app: FastifyInstance,
    base: string,
    cookie: string,
    accountId: string,
  ): Promise<LightMyRequestResponse> =>
    app.inject({
      method: 'POST',
      url: `${base}/transfer`,
      headers: { cookie },
      payload: { accountId },
    })

  it('is an OFFER: nothing moves until the recipient accepts', async () => {
    await withTestDatabase(async (pool) => {
      const { app, db, base, dm, player, playerId, worldId } = await setup(pool)

      expect((await offer(app, base, dm, playerId)).statusCode).toBe(200)
      // still the dm's world
      expect(await roles(db, worldId)).toEqual({ dm: 'owner', player: 'player', other: 'player' })
      // and the offer is visible to members
      const pending = await app.inject({
        method: 'GET',
        url: `${base}/transfer`,
        headers: { cookie: player },
      })
      expect(pending.json().pending.username).toBe('player')

      expect(
        (
          await app.inject({
            method: 'POST',
            url: `${base}/transfer/accept`,
            headers: { cookie: player },
          })
        ).statusCode,
      ).toBe(200)

      // exactly one owner, and it is the accepter; the old owner is a player
      expect(await roles(db, worldId)).toEqual({ dm: 'player', player: 'owner', other: 'player' })
      const world = await db
        .selectFrom('worlds')
        .select(['owner_id', 'pending_owner_id'])
        .where('slug', '=', worldId)
        .executeTakeFirstOrThrow()
      expect(world.owner_id).toBe(playerId)
      expect(world.pending_owner_id).toBeNull()
    })
  })

  it('keeps the old owner’s data — transfer is not removal', async () => {
    await withTestDatabase(async (pool) => {
      const { app, db, base, dm, player, playerId, dmId } = await setup(pool)
      await app.inject({
        method: 'POST',
        url: `${base}/notes`,
        headers: { cookie: dm },
        payload: { body: 'gm note' },
      })

      await offer(app, base, dm, playerId)
      await app.inject({
        method: 'POST',
        url: `${base}/transfer/accept`,
        headers: { cookie: player },
      })

      const notes = await db
        .selectFrom('player_notes')
        .select('id')
        .where('author_id', '=', dmId)
        .execute()
      expect(notes).toHaveLength(1)
    })
  })

  it('rejects a transfer to a non-member', async () => {
    await withTestDatabase(async (pool) => {
      const { app, base, dm } = await setup(pool)
      const outsiderId = 'no-such-account'
      const res = await offer(app, base, dm, outsiderId)
      expect(res.statusCode).toBe(400)
      expect(res.json().error.code).toBe('not_a_member')
    })
  })

  it('rejects a player offering the world they do not own', async () => {
    await withTestDatabase(async (pool) => {
      const { app, base, player, otherId } = await setup(pool)
      expect((await offer(app, base, player, otherId)).statusCode).toBe(403)
    })
  })

  it('refuses an accept from anyone the offer does not name', async () => {
    await withTestDatabase(async (pool) => {
      const { app, db, base, dm, other, playerId, worldId } = await setup(pool)
      await offer(app, base, dm, playerId)

      const res = await app.inject({
        method: 'POST',
        url: `${base}/transfer/accept`,
        headers: { cookie: other },
      })

      expect(res.statusCode).toBe(403)
      expect(await roles(db, worldId)).toEqual({ dm: 'owner', player: 'player', other: 'player' })
    })
  })

  it('refuses an accept when there is no offer at all', async () => {
    await withTestDatabase(async (pool) => {
      const { app, base, player } = await setup(pool)
      const res = await app.inject({
        method: 'POST',
        url: `${base}/transfer/accept`,
        headers: { cookie: player },
      })
      expect(res.statusCode).toBe(403)
    })
  })

  it('lets the owner withdraw an outstanding offer', async () => {
    await withTestDatabase(async (pool) => {
      const { app, base, dm, player, playerId } = await setup(pool)
      await offer(app, base, dm, playerId)

      expect(
        (await app.inject({ method: 'DELETE', url: `${base}/transfer`, headers: { cookie: dm } }))
          .statusCode,
      ).toBe(200)

      const pending = await app.inject({
        method: 'GET',
        url: `${base}/transfer`,
        headers: { cookie: dm },
      })
      expect(pending.json().pending).toBeNull()
      // and the withdrawn offer cannot still be accepted
      expect(
        (
          await app.inject({
            method: 'POST',
            url: `${base}/transfer/accept`,
            headers: { cookie: player },
          })
        ).statusCode,
      ).toBe(403)
    })
  })

  it('refuses a player withdrawing an offer', async () => {
    await withTestDatabase(async (pool) => {
      const { app, base, dm, player, playerId } = await setup(pool)
      await offer(app, base, dm, playerId)
      const res = await app.inject({
        method: 'DELETE',
        url: `${base}/transfer`,
        headers: { cookie: player },
      })
      expect(res.statusCode).toBe(403)
    })
  })

  it('drops the offer if the offered-to member leaves first', async () => {
    await withTestDatabase(async (pool) => {
      const { app, base, dm, player, playerId } = await setup(pool)
      await offer(app, base, dm, playerId)

      await app.inject({ method: 'POST', url: `${base}/leave`, headers: { cookie: player } })

      const pending = await app.inject({
        method: 'GET',
        url: `${base}/transfer`,
        headers: { cookie: dm },
      })
      expect(pending.json().pending).toBeNull()
    })
  })

  it('never leaves the world ownerless under two simultaneous accepts', async () => {
    await withTestDatabase(async (pool) => {
      const { app, db, base, dm, player, playerId, worldId } = await setup(pool)
      await offer(app, base, dm, playerId)

      const accept = (): Promise<LightMyRequestResponse> =>
        app.inject({ method: 'POST', url: `${base}/transfer/accept`, headers: { cookie: player } })
      const [a, b] = await Promise.all([accept(), accept()])

      // one wins, one is refused — and never two owners
      expect([a.statusCode, b.statusCode].sort()).toEqual([200, 403])
      expect(await roles(db, worldId)).toEqual({ dm: 'player', player: 'owner', other: 'player' })
    })
  })
})
