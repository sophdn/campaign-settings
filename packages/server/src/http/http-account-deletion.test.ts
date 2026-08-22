import type { FastifyInstance, LightMyRequestResponse } from 'fastify'
import type { Pool } from 'pg'
import { describe, expect, it } from 'vitest'
import { createScryptAuth } from '../auth/service'
import { createDb } from '../db/kysely'
import { migrateToLatest } from '../db/migrator'
import { openFlags } from '../flags/config'
import { markEmailVerified, withTestDatabase } from '../db/test-database'
import { buildApp } from './app'

const SECRET = 'test-secret-test-secret-test-secret'
const PW = 'pw-123456'

async function login(app: FastifyInstance, username: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/login',
    payload: { username, password: PW },
  })
  const c = res.cookies.find((x) => x.name === 'cs_session')
  if (!c) throw new Error(`no session cookie for ${username}`)
  return `cs_session=${c.value}`
}

/**
 * `dm` owns a world; `player` is a member of it with a note, a character, a
 * suggestion, an entity grant, and an outstanding reset token — one row in every
 * table that hangs off an account, so the cascade can be checked table by table.
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

  const dmAccount = await auth.createAccount('dm', PW, 'dm@example.com')
  const playerAccount = await auth.createAccount('player', PW, 'player@example.com')
  // World creation and invitation are gated on verification; this suite's
  // subject is the deletion cascade, not the gate.
  await markEmailVerified(db, dmAccount.id)
  const dm = await login(app, 'dm')
  const player = await login(app, 'player')

  const created = await app.inject({
    method: 'POST',
    url: '/api/worlds',
    headers: { cookie: dm },
    payload: { name: 'W' },
  })
  const worldId = created.json().world.slug as string
  const base = `/api/worlds/${worldId}`
  await app.inject({
    method: 'POST',
    url: `${base}/members`,
    headers: { cookie: dm },
    payload: { accountId: playerAccount.id },
  })

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
    payload: { body: 'note' },
  })
  // The DM's PC page, pointing at the player. Deleting the account must clear
  // the pointer via ON DELETE SET NULL and leave the page standing.
  const pc = await app.inject({
    method: 'POST',
    url: `${base}/entities/pc`,
    headers: { cookie: dm },
    payload: { name: 'PC', account_id: playerAccount.id },
  })
  const pcId = pc.json().entity.id as string
  await app.inject({
    method: 'POST',
    url: `${base}/suggestions`,
    headers: { cookie: player },
    payload: { targetKind: 'npc', targetId: entityId, proposed: { name: 'Renamed' } },
  })
  // an outstanding reset token for the player
  await app.inject({
    method: 'POST',
    url: '/api/password-reset/request',
    payload: { identifier: 'player' },
  })
  // an invitation the dm sent, aimed at the player
  await app.inject({
    method: 'POST',
    url: `${base}/invitations`,
    headers: { cookie: dm },
    payload: { username: 'player' },
  })

  return {
    app,
    db,
    base,
    worldId,
    dm,
    player,
    dmId: dmAccount.id,
    playerId: playerAccount.id,
    entityId,
    pcId,
  }
}

const del = (
  app: FastifyInstance,
  cookie: string,
  password: string,
): Promise<LightMyRequestResponse> =>
  app.inject({ method: 'DELETE', url: '/api/account', headers: { cookie }, payload: { password } })

describe('account deletion — the gate', () => {
  it('demands the current password', async () => {
    await withTestDatabase(async (pool) => {
      const { app, db, player, playerId } = await setup(pool)

      const res = await del(app, player, 'wrong-password')

      expect(res.statusCode).toBe(401)
      const still = await db
        .selectFrom('accounts')
        .select('id')
        .where('id', '=', playerId)
        .execute()
      expect(still).toHaveLength(1)
    })
  })

  it('rejects an anonymous caller', async () => {
    await withTestDatabase(async (pool) => {
      const { app } = await setup(pool)
      const res = await app.inject({
        method: 'DELETE',
        url: '/api/account',
        payload: { password: PW },
      })
      expect(res.statusCode).toBe(401)
    })
  })

  it('refuses while the account owns worlds, and names them', async () => {
    await withTestDatabase(async (pool) => {
      const { app, db, dm, dmId } = await setup(pool)

      const res = await del(app, dm, PW)

      expect(res.statusCode).toBe(409)
      expect(res.json().error.code).toBe('owns_worlds')
      expect(res.json().error.worlds.map((w: { name: string }) => w.name)).toEqual(['W'])
      expect(
        await db.selectFrom('accounts').select('id').where('id', '=', dmId).execute(),
      ).toHaveLength(1)
    })
  })

  it('lists the blocking worlds up front so the UI need not provoke a 409', async () => {
    await withTestDatabase(async (pool) => {
      const { app, dm, player } = await setup(pool)

      const owner = await app.inject({
        method: 'GET',
        url: '/api/account/deletion-blockers',
        headers: { cookie: dm },
      })
      expect(owner.json().worlds.map((w: { name: string }) => w.name)).toEqual(['W'])

      const member = await app.inject({
        method: 'GET',
        url: '/api/account/deletion-blockers',
        headers: { cookie: player },
      })
      expect(member.json().worlds).toEqual([])
    })
  })

  it('lets the owner delete once the world is transferred away', async () => {
    await withTestDatabase(async (pool) => {
      const { app, db, base, dm, player, playerId, dmId } = await setup(pool)

      await app.inject({
        method: 'POST',
        url: `${base}/transfer`,
        headers: { cookie: dm },
        payload: { accountId: playerId },
      })
      await app.inject({
        method: 'POST',
        url: `${base}/transfer/accept`,
        headers: { cookie: player },
      })

      expect((await del(app, dm, PW)).statusCode).toBe(200)

      // the account is gone and the world survives, now owned by the accepter
      expect(await db.selectFrom('accounts').select('id').where('id', '=', dmId).execute()).toEqual(
        [],
      )
      const world = await db
        .selectFrom('worlds')
        .select('owner_id')
        .where('slug', '=', base.split('/').pop() as string)
        .executeTakeFirstOrThrow()
      expect(world.owner_id).toBe(playerId)
    })
  })
})

describe('account deletion — the cascade', () => {
  it('removes every row hanging off the account, table by table', async () => {
    await withTestDatabase(async (pool) => {
      const { app, db, player, playerId, pcId } = await setup(pool)

      expect((await del(app, player, PW)).statusCode).toBe(200)

      const remaining = async (
        table: 'auth_sessions' | 'password_reset_tokens' | 'world_members',
      ): Promise<unknown[]> =>
        db.selectFrom(table).select('account_id').where('account_id', '=', playerId).execute()

      expect(await remaining('auth_sessions')).toEqual([])
      expect(await remaining('password_reset_tokens')).toEqual([])
      expect(await remaining('world_members')).toEqual([])
      expect(
        await db
          .selectFrom('player_notes')
          .select('id')
          .where('author_id', '=', playerId)
          .execute(),
      ).toEqual([])
      // NOT deleted — unlinked. ON DELETE SET NULL on pc_details.account_id is
      // what keeps a departing account from taking the DM's write-up with it.
      const pcAfter = await db
        .selectFrom('pc_details')
        .select(['entity_id', 'account_id'])
        .where('entity_id', '=', pcId)
        .executeTakeFirst()
      expect(pcAfter?.account_id).toBeNull()
      expect(
        await db.selectFrom('suggestions').select('id').where('author_id', '=', playerId).execute(),
      ).toEqual([])
      expect(
        await db
          .selectFrom('world_invitations')
          .select('id')
          .where('invitee_account_id', '=', playerId)
          .execute(),
      ).toEqual([])
      // the FK 0012 added — without it these rows would survive as orphans
      expect(
        await db
          .selectFrom('entity_visibility')
          .select('account_id')
          .where('account_id', '=', playerId)
          .execute(),
      ).toEqual([])
    })
  })

  it('leaves the world and its content standing', async () => {
    await withTestDatabase(async (pool) => {
      const { app, db, player, entityId, worldId } = await setup(pool)

      await del(app, player, PW)

      expect(
        await db.selectFrom('worlds').select('id').where('slug', '=', worldId).execute(),
      ).toHaveLength(1)
      expect(
        await db.selectFrom('entities').select('id').where('id', '=', entityId).execute(),
      ).toHaveLength(1)
    })
  })

  it('clears the session cookie so the browser stops presenting a dead credential', async () => {
    await withTestDatabase(async (pool) => {
      const { app, player } = await setup(pool)

      const res = await del(app, player, PW)

      const cleared = res.cookies.find((c) => c.name === 'cs_session')
      expect(cleared?.value).toBe('')
    })
  })

  it('is a HARD delete — the username frees up and the credentials stop working', async () => {
    await withTestDatabase(async (pool) => {
      const { app, player } = await setup(pool)
      await del(app, player, PW)

      const relogin = await app.inject({
        method: 'POST',
        url: '/api/login',
        payload: { username: 'player', password: PW },
      })
      expect(relogin.statusCode).toBe(401)

      // and nothing soft-deleted is squatting on the name
      const auth = createScryptAuth(createDb(pool))
      await expect(auth.createAccount('player', PW, 'someone@example.com')).resolves.toBeTruthy()
    })
  })

  it('drops a pending ownership offer aimed at the deleted account', async () => {
    await withTestDatabase(async (pool) => {
      const { app, db, base, dm, player, playerId, worldId } = await setup(pool)
      await app.inject({
        method: 'POST',
        url: `${base}/transfer`,
        headers: { cookie: dm },
        payload: { accountId: playerId },
      })

      await del(app, player, PW)

      const world = await db
        .selectFrom('worlds')
        .select('pending_owner_id')
        .where('slug', '=', worldId)
        .executeTakeFirstOrThrow()
      expect(world.pending_owner_id).toBeNull()
    })
  })
})

describe('the schema refuses too, not just the handler', () => {
  /**
   * 0012 turned `worlds.owner_id` from CASCADE to RESTRICT. Without it, any
   * future path that deletes an account row — a script, a test helper, a later
   * feature — would silently take that account's worlds and every member's work
   * inside them. This asserts the database itself says no.
   */
  it('refuses a raw account delete while it owns a world', async () => {
    await withTestDatabase(async (pool) => {
      const { db, dmId } = await setup(pool)

      await expect(db.deleteFrom('accounts').where('id', '=', dmId).execute()).rejects.toThrow(
        /violates foreign key constraint/i,
      )
    })
  })
})
