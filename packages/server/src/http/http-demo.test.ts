import type { FastifyInstance, LightMyRequestResponse } from 'fastify'
import type { Pool } from 'pg'
import { describe, expect, it } from 'vitest'
import { createScryptAuth } from '../auth/service'
import { createDb } from '../db/kysely'
import { migrateToLatest } from '../db/migrator'
import { markEmailVerified, withTestDatabase } from '../db/test-database'
import { allFlags, openFlags } from '../flags/config'
import type { FeatureFlags } from '../flags/registry'
import { buildApp } from './app'

const SECRET = 'test-secret-test-secret-test-secret'
const PW = 'pw-123456'

/**
 * `dm` owns a world containing an npc; `demo` is a member of it and is the
 * shared demo principal. Demo mode is ON unless a test says otherwise.
 */
async function setup(pool: Pool, flags: FeatureFlags = openFlags()) {
  const db = createDb(pool)
  await migrateToLatest(db)
  const auth = createScryptAuth(db)
  const app = buildApp({
    db,
    auth,
    cookieSecret: SECRET,
    cookieSecure: false,
    flags,
  })
  await app.ready()

  const dmAccount = await auth.createAccount('dm', PW, 'dm@example.com')
  const demoAccount = await auth.createAccount('demo', PW, 'demo@example.com')
  const player = await auth.createAccount('player', PW, 'player@example.com')
  await markEmailVerified(db, dmAccount.id)

  const dmLogin = await app.inject({
    method: 'POST',
    url: '/api/login',
    payload: { username: 'dm', password: PW },
  })
  const dm = `cs_session=${dmLogin.cookies.find((c) => c.name === 'cs_session')?.value}`

  const created = await app.inject({
    method: 'POST',
    url: '/api/worlds',
    headers: { cookie: dm },
    payload: { name: 'W' },
  })
  const worldId = created.json().world.slug as string
  for (const id of [demoAccount.id, player.id]) {
    await app.inject({
      method: 'POST',
      url: `/api/worlds/${worldId}/members`,
      headers: { cookie: dm },
      payload: { accountId: id },
    })
  }
  const npc = await app.inject({
    method: 'POST',
    url: `/api/worlds/${worldId}/entities/npc`,
    headers: { cookie: dm },
    payload: { name: 'Someone' },
  })

  const playerLogin = await app.inject({
    method: 'POST',
    url: '/api/login',
    payload: { username: 'player', password: PW },
  })

  return {
    app,
    db,
    dm,
    worldId,
    entityId: npc.json().entity.id as string,
    demoId: demoAccount.id,
    player: `cs_session=${playerLogin.cookies.find((c) => c.name === 'cs_session')?.value}`,
  }
}

const demoLogin = (app: FastifyInstance): Promise<LightMyRequestResponse> =>
  app.inject({ method: 'POST', url: '/api/demo-login' })

const cookieOf = (res: LightMyRequestResponse): string =>
  `cs_session=${res.cookies.find((c) => c.name === 'cs_session')?.value}`

describe('demo auto-login', () => {
  it('yields an authenticated session as the demo player with no credentials', async () => {
    await withTestDatabase(async (pool) => {
      const { app, demoId } = await setup(pool)

      const res = await demoLogin(app)

      expect(res.statusCode).toBe(200)
      expect(res.json().account.username).toBe('demo')
      const me = await app.inject({
        method: 'GET',
        url: '/api/me',
        headers: { cookie: cookieOf(res) },
      })
      expect(me.statusCode).toBe(200)
      expect(me.json().account.id).toBe(demoId)
    })
  })

  /**
   * The endpoint takes no input at all, which is what makes "can only ever be
   * the demo principal" true by construction. This asserts that a payload
   * naming somebody else changes nothing.
   */
  it('cannot be coerced into another identity', async () => {
    await withTestDatabase(async (pool) => {
      const { app } = await setup(pool)

      for (const payload of [
        { username: 'dm' },
        { accountId: 'anything' },
        { username: 'dm', password: PW },
      ]) {
        const res = await app.inject({ method: 'POST', url: '/api/demo-login', payload })
        expect(res.json().account.username).toBe('demo')
      }
    })
  })

  it('creates no new row per visit — a flood of visits shares one session', async () => {
    await withTestDatabase(async (pool) => {
      const { app, db, demoId } = await setup(pool)

      const first = await demoLogin(app)
      for (let i = 0; i < 5; i++) await demoLogin(app)

      const rows = await db
        .selectFrom('auth_sessions')
        .select('id')
        .where('account_id', '=', demoId)
        .execute()
      expect(rows).toHaveLength(1)
      // and every visitor got the SAME session
      expect(cookieOf(await demoLogin(app))).toBe(cookieOf(first))
    })
  })

  it('creates no account — the demo account must be provisioned, not minted', async () => {
    await withTestDatabase(async (pool) => {
      const db = createDb(pool)
      await migrateToLatest(db)
      const app = buildApp({
        db,
        auth: createScryptAuth(db),
        cookieSecret: SECRET,
        cookieSecure: false,
        flags: openFlags(),
      })
      await app.ready()

      const res = await demoLogin(app)

      expect(res.statusCode).toBe(503)
      expect(res.json().error.code).toBe('demo_unavailable')
      expect(await db.selectFrom('accounts').select('id').execute()).toEqual([])
    })
  })

  it('is refused entirely when demo mode is off', async () => {
    await withTestDatabase(async (pool) => {
      const { app } = await setup(pool, { ...openFlags(), demoModeEnabled: false })

      const res = await demoLogin(app)

      expect(res.statusCode).toBe(403)
      expect(res.json().error.code).toBe('surface_disabled')
    })
  })
})

describe('demo read-only enforcement', () => {
  it('denies a mutation on EVERY surface, and allows the same one for a normal player or owner', async () => {
    await withTestDatabase(async (pool) => {
      const { app, worldId, entityId, dm, player } = await setup(pool)
      const demo = cookieOf(await demoLogin(app))
      const base = `/api/worlds/${worldId}`

      // one representative mutation per surface the task names
      const mutations: {
        name: string
        method: 'POST' | 'PATCH' | 'DELETE'
        url: string
        payload?: unknown
      }[] = [
        { name: 'world creation', method: 'POST', url: '/api/worlds', payload: { name: 'Mine' } },
        {
          name: 'entity write',
          method: 'PATCH',
          url: `${base}/entities/npc/${entityId}`,
          payload: { name: 'Defaced' },
        },
        {
          name: 'membership/GM action',
          method: 'POST',
          url: `${base}/members`,
          payload: { accountId: 'someone' },
        },
        {
          name: 'player-to-GM suggestion',
          method: 'POST',
          url: `${base}/suggestions`,
          payload: { targetKind: 'npc', targetId: entityId, proposed: { name: 'x' } },
        },
        { name: 'player note', method: 'POST', url: `${base}/notes`, payload: { body: 'hi' } },
        {
          name: 'account credentials',
          method: 'POST',
          url: '/api/account/password',
          payload: { currentPassword: PW, newPassword: 'new-password-1' },
        },
        { name: 'leaving the world', method: 'POST', url: `${base}/leave` },
      ]

      for (const m of mutations) {
        const res = await app.inject({
          method: m.method,
          url: m.url,
          headers: { cookie: demo },
          ...(m.payload ? { payload: m.payload } : {}),
        })
        expect(res.statusCode, m.name).toBe(403)
        expect(res.json().error.code, m.name).toBe('demo_read_only')
      }

      // the same writes are NOT blanket-disabled — a normal player and the
      // owner still get through, so this is the principal, not a kill switch
      const playerNote = await app.inject({
        method: 'POST',
        url: `${base}/notes`,
        headers: { cookie: player },
        payload: { body: 'hi' },
      })
      expect(playerNote.statusCode).toBe(201)
      const ownerEdit = await app.inject({
        method: 'PATCH',
        url: `${base}/entities/npc/${entityId}`,
        headers: { cookie: dm },
        payload: { name: 'Renamed' },
      })
      expect(ownerEdit.statusCode).toBe(200)
    })
  })

  it('still lets the demo principal READ everything it is entitled to', async () => {
    await withTestDatabase(async (pool) => {
      const { app, worldId } = await setup(pool)
      const demo = cookieOf(await demoLogin(app))
      const base = `/api/worlds/${worldId}`

      for (const url of [
        '/api/worlds',
        base,
        `${base}/wiki`,
        `${base}/entities/npc`,
        `${base}/members`,
      ]) {
        expect(
          (await app.inject({ method: 'GET', url, headers: { cookie: demo } })).statusCode,
          url,
        ).toBe(200)
      }
    })
  })

  it('lets a demo visitor leave without signing out every other visitor', async () => {
    await withTestDatabase(async (pool) => {
      const { app, db, demoId } = await setup(pool)
      const demo = cookieOf(await demoLogin(app))

      const out = await app.inject({
        method: 'POST',
        url: '/api/logout',
        headers: { cookie: demo },
      })
      expect(out.statusCode).toBe(200)

      // the SHARED row survives, so the next visitor is unaffected
      const rows = await db
        .selectFrom('auth_sessions')
        .select('id')
        .where('account_id', '=', demoId)
        .execute()
      expect(rows).toHaveLength(1)
      expect(
        (await app.inject({ method: 'GET', url: '/api/me', headers: { cookie: demo } })).statusCode,
      ).toBe(200)
    })
  })

  it('is inert when demo mode is off — the account is then just an account', async () => {
    await withTestDatabase(async (pool) => {
      const { app, worldId } = await setup(pool, { ...allFlags(true), demoModeEnabled: false })
      const login = await app.inject({
        method: 'POST',
        url: '/api/login',
        payload: { username: 'demo', password: PW },
      })
      const cookie = cookieOf(login)

      const res = await app.inject({
        method: 'POST',
        url: `/api/worlds/${worldId}/notes`,
        headers: { cookie },
        payload: { body: 'hi' },
      })
      expect(res.statusCode).toBe(201)
    })
  })

  it('does not treat a DIFFERENT account named similarly as the demo principal', async () => {
    await withTestDatabase(async (pool) => {
      const { app, worldId, player } = await setup(pool)
      // `player` is not the demo account, and demo mode is on
      const res = await app.inject({
        method: 'POST',
        url: `/api/worlds/${worldId}/notes`,
        headers: { cookie: player },
        payload: { body: 'hi' },
      })
      expect(res.statusCode).toBe(201)
    })
  })
})
