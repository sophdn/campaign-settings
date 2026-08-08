import type { FastifyInstance, LightMyRequestResponse } from 'fastify'
import type { Pool } from 'pg'
import { describe, expect, it } from 'vitest'
import { createScryptAuth } from '../auth/service'
import { createDb } from '../db/kysely'
import { migrateToLatest } from '../db/migrator'
import { openFlags } from '../flags/config'
import { withTestDatabase } from '../db/test-database'
import { type AppDeps, buildApp } from './app'

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
 * A world owned by `dm`, with `player` as a member and `outsider` in neither.
 * `stranger` exists as an account but belongs to no world — the person a DM
 * would actually be looking up in order to invite them.
 */
async function setup(pool: Pool, extra: Partial<AppDeps> = {}) {
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
    ...extra,
  })
  await app.ready()

  await auth.createAccount('dm', 'pw-123456')
  const player = await auth.createAccount('player', 'pw-123456')
  await auth.createAccount('outsider', 'pw-123456')
  const stranger = await auth.createAccount('stranger', 'pw-123456')

  const dm = await login(app, 'dm', 'pw-123456')
  const playerCookie = await login(app, 'player', 'pw-123456')
  const outsider = await login(app, 'outsider', 'pw-123456')

  const created = await app.inject({
    method: 'POST',
    url: '/api/worlds',
    headers: { cookie: dm },
    payload: { name: 'W' },
  })
  const worldId = created.json().world.slug as string
  await app.inject({
    method: 'POST',
    url: `/api/worlds/${worldId}/members`,
    headers: { cookie: dm },
    payload: { accountId: player.id },
  })
  return { app, dm, player: playerCookie, outsider, worldId, stranger }
}

const lookup = (
  app: FastifyInstance,
  worldId: string,
  username: string,
  cookie?: string,
): Promise<LightMyRequestResponse> =>
  app.inject({
    method: 'GET',
    url: `/api/worlds/${worldId}/account-lookup?username=${encodeURIComponent(username)}`,
    ...(cookie ? { headers: { cookie } } : {}),
  })

describe('account lookup', () => {
  it('resolves an exact username to the id the member and grant routes take', async () => {
    await withTestDatabase(async (pool) => {
      const { app, dm, worldId, stranger } = await setup(pool)

      const res = await lookup(app, worldId, 'stranger', dm)
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ account: { id: stranger.id, username: 'stranger' } })

      // the returned id is directly usable as the members route's accountId
      const granted = await app.inject({
        method: 'POST',
        url: `/api/worlds/${worldId}/members`,
        headers: { cookie: dm },
        payload: { accountId: res.json().account.id },
      })
      expect(granted.statusCode).toBe(200)
      await app.close()
    })
  })

  it('returns a null account for an unknown username rather than a 404', async () => {
    await withTestDatabase(async (pool) => {
      const { app, dm, worldId } = await setup(pool)
      const res = await lookup(app, worldId, 'nobody-by-that-name', dm)
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ account: null })
      await app.close()
    })
  })

  it('never leaks an email, only the minimal public reference', async () => {
    await withTestDatabase(async (pool) => {
      const { app, dm, worldId } = await setup(pool)
      const db = createDb(pool)
      await db
        .updateTable('accounts')
        .set({ email: 'stranger@example.com' })
        .where('username', '=', 'stranger')
        .execute()

      const res = await lookup(app, worldId, 'stranger', dm)
      expect(Object.keys(res.json().account as object).sort()).toEqual(['id', 'username'])
      expect(res.body).not.toContain('example.com')
      await app.close()
    })
  })

  it('matches the whole name in any capitalisation — but never a prefix or a superstring', async () => {
    await withTestDatabase(async (pool) => {
      const { app, dm, worldId, stranger } = await setup(pool)
      // since 0009 a username is one identity regardless of case, so a DM who
      // types the name as their player capitalises it still finds them
      for (const typed of ['stranger', 'Stranger', 'STRANGER', 'sTrAnGeR']) {
        expect((await lookup(app, worldId, typed, dm)).json(), typed).toEqual({
          account: { id: stranger.id, username: 'stranger' },
        })
      }
      // case folding is the ONLY leniency: still no prefix matching...
      expect((await lookup(app, worldId, 'strang', dm)).json()).toEqual({ account: null })
      // ...no superstring...
      expect((await lookup(app, worldId, 'strangers', dm)).json()).toEqual({ account: null })
      // ...and no substring-anywhere
      expect((await lookup(app, worldId, 'rang', dm)).json()).toEqual({ account: null })
      await app.close()
    })
  })

  it('refuses a member who is not the owner, for a username that exists', async () => {
    await withTestDatabase(async (pool) => {
      const { app, player, worldId } = await setup(pool)
      const res = await lookup(app, worldId, 'stranger', player)
      expect(res.statusCode).toBe(403)
      expect(res.json()).toEqual({ error: { code: 'forbidden', message: expect.any(String) } })

      // ...and the same 403 for one that does not: permission is decided before
      // the lookup, so a non-owner learns nothing about who exists
      const ghost = await lookup(app, worldId, 'nobody-by-that-name', player)
      expect(ghost.statusCode).toBe(403)
      expect(ghost.json()).toEqual(res.json())
      await app.close()
    })
  })

  it('refuses a non-member and an unauthenticated caller', async () => {
    await withTestDatabase(async (pool) => {
      const { app, outsider, worldId } = await setup(pool)
      expect((await lookup(app, worldId, 'stranger', outsider)).statusCode).toBe(403)
      expect((await lookup(app, worldId, 'stranger')).statusCode).toBe(401)
      await app.close()
    })
  })

  it('rejects a missing or empty username', async () => {
    await withTestDatabase(async (pool) => {
      const { app, dm, worldId } = await setup(pool)
      const empty = await lookup(app, worldId, '', dm)
      expect(empty.statusCode).toBe(400)
      expect(empty.json().error.code).toBe('invalid_request')

      const missing = await app.inject({
        method: 'GET',
        url: `/api/worlds/${worldId}/account-lookup`,
        headers: { cookie: dm },
      })
      expect(missing.statusCode).toBe(400)
      await app.close()
    })
  })

  it('rate-limits the caller once the ceiling is crossed, in the app error envelope', async () => {
    await withTestDatabase(async (pool) => {
      const { app, dm, worldId } = await setup(pool, {
        lookupRateLimit: { max: 3, timeWindow: 60_000 },
      })
      // 3 allowed, the 4th refused — the same shape the production limit has,
      // just small enough to reach without firing the real quota
      for (let i = 0; i < 3; i++) {
        expect((await lookup(app, worldId, 'stranger', dm)).statusCode).toBe(200)
      }
      const limited = await lookup(app, worldId, 'stranger', dm)
      expect(limited.statusCode).toBe(429)
      expect(limited.json()).toEqual({
        error: { code: 'rate_limited', message: expect.any(String) },
      })
      await app.close()
    })
  }, 20_000)

  it('meters each caller separately, so one owner cannot exhaust another', async () => {
    await withTestDatabase(async (pool) => {
      const { app, dm, outsider, worldId } = await setup(pool, {
        lookupRateLimit: { max: 1, timeWindow: 60_000 },
      })
      expect((await lookup(app, worldId, 'stranger', dm)).statusCode).toBe(200)
      expect((await lookup(app, worldId, 'stranger', dm)).statusCode).toBe(429)
      // a different session has its own budget (403 here, not 429 — it is
      // refused on ownership, which proves it was never rate-limited)
      expect((await lookup(app, worldId, 'stranger', outsider)).statusCode).toBe(403)
      await app.close()
    })
  })
})
