import type { FastifyInstance } from 'fastify'
import type { Pool } from 'pg'
import { describe, expect, it } from 'vitest'
import { createScryptAuth } from '../auth/service'
import { createDb } from '../db/kysely'
import { migrateToLatest } from '../db/migrator'
import { markEmailVerified, withTestDatabase } from '../db/test-database'
import { openFlags } from '../flags/config'
import { buildApp } from './app'

const SECRET = 'test-secret-test-secret-test-secret'
const PW = 'pw-123456'

/**
 * The guard policy over the WHOLE route table (task 3551).
 *
 * The criterion this answers is "no cross-tenant data leakage across the route
 * surface — every /api/worlds/:worldId/* route re-checks membership rather than
 * trusting the path parameter". That is a property of a FAMILY, and a family is
 * not something a sample can establish: the route that leaks is by definition
 * the one somebody forgot, which is exactly the one a hand-written list of spot
 * checks also forgets.
 *
 * So these read `app.routeGuards` — the real registered table, recorded by an
 * onRoute hook in buildApp — and assert over all of it. A route added tomorrow
 * without `inWorld` fails here without anyone remembering to add a test.
 */
async function buildReadyApp(pool: Pool): Promise<FastifyInstance> {
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
  return app
}

/**
 * The routes a caller with NO session may reach, and the complete list of them.
 *
 * Written out rather than derived, because the point is that adding to it is a
 * DELIBERATE act. A new unguarded route fails this test until somebody puts it
 * here on purpose, which is the moment to ask whether it should be public.
 */
const PUBLIC_ROUTES = [
  'GET /api/health',
  'HEAD /api/health',
  'GET /api/config',
  'HEAD /api/config',
  'POST /api/login',
  'POST /api/register',
  'POST /api/logout',
  'POST /api/demo-login',
  'POST /api/password-reset/request',
  'POST /api/password-reset/confirm',
  'POST /api/verify-email',
  'GET /api/invitations/:token',
  'HEAD /api/invitations/:token',
].sort()

describe('route guards, over the whole table', () => {
  it('re-checks world membership on EVERY world-scoped route', async () => {
    await withTestDatabase(async (pool) => {
      const app = await buildReadyApp(pool)
      const worldRoutes = app.routeGuards.filter((r) => r.url.startsWith('/api/worlds/:worldId'))

      // guard against the assertion silently covering nothing
      expect(worldRoutes.length).toBeGreaterThan(50)
      for (const route of worldRoutes) {
        const where = `${route.method} ${route.url}`
        expect(route.guards, where).toContain('requireAccount')
        expect(route.guards, where).toContain('requireWorld')
      }
    })
  })

  it('gates the whole account family on both a session and the flag', async () => {
    await withTestDatabase(async (pool) => {
      const app = await buildReadyApp(pool)
      const accountRoutes = app.routeGuards.filter(
        (r) => r.url === '/api/account' || r.url.startsWith('/api/account/'),
      )

      expect(accountRoutes.length).toBeGreaterThan(5)
      for (const route of accountRoutes) {
        const where = `${route.method} ${route.url}`
        expect(route.guards, where).toContain('requireAccount')
        expect(route.guards, where).toContain('requireAccountManagement')
      }
    })
  })

  it('has exactly the anonymous surface it is meant to have, and no more', async () => {
    await withTestDatabase(async (pool) => {
      const app = await buildReadyApp(pool)

      const unguarded = app.routeGuards
        .filter((r) => r.guards.length === 0)
        .flatMap((r) => r.method.split(',').map((m) => `${m} ${r.url}`))
        .sort()

      expect(unguarded).toEqual(PUBLIC_ROUTES)
    })
  })
})

describe('cross-tenant isolation, exercised rather than inspected', () => {
  /**
   * The structural test above proves the guard is ATTACHED. This one proves the
   * guard REFUSES — two different claims, and a preHandler that was attached but
   * answered "fine" would pass the first and fail this.
   */
  it('refuses a signed-in stranger every world-scoped route, with no 2xx anywhere', async () => {
    await withTestDatabase(async (pool) => {
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

      const owner = await auth.createAccount('owner', PW, 'owner@example.com')
      await markEmailVerified(db, owner.id)
      await auth.createAccount('stranger', PW, 'stranger@example.com')
      const cookieFor = async (username: string): Promise<string> => {
        const res = await app.inject({
          method: 'POST',
          url: '/api/login',
          payload: { username, password: PW },
        })
        return `cs_session=${res.cookies.find((c) => c.name === 'cs_session')?.value}`
      }
      const ownerCookie = await cookieFor('owner')
      const created = await app.inject({
        method: 'POST',
        url: '/api/worlds',
        headers: { cookie: ownerCookie },
        payload: { name: 'Private' },
      })
      const worldId = created.json().world.slug as string
      const strangerCookie = await cookieFor('stranger')

      // Every world-scoped route, with the path parameters filled in with
      // values the stranger has no business reaching. The membership check runs
      // in a preHandler, so it answers before the handler ever sees these.
      const routes = app.routeGuards.filter((r) => r.url.startsWith('/api/worlds/:worldId'))
      expect(routes.length).toBeGreaterThan(50)

      for (const route of routes) {
        for (const method of route.method.split(',')) {
          if (method === 'HEAD') continue
          const url = route.url
            .replace(':worldId', worldId)
            .replace(':kind', 'npc')
            .replace(/:[A-Za-z]+/g, 'some-id')
          const res = await app.inject({
            method: method as 'GET' | 'POST' | 'PATCH' | 'DELETE',
            url,
            headers: { cookie: strangerCookie },
            payload: {},
          })
          // 403 is the membership refusal; a malformed body can land 400 first,
          // and either way nothing succeeded. The assertion that matters is that
          // NOTHING in this family answers a stranger with a success.
          expect(res.statusCode, `${method} ${url}`).toBeGreaterThanOrEqual(400)
        }
      }
    })
  })

  /**
   * Named in the acceptance criteria on its own because it is the route that
   * hands over the entire world in one response — the worst single thing to get
   * wrong, and worth an assertion that does not depend on the loop above
   * happening to include it.
   */
  it('keeps the world export owner-only against a member who is not the owner', async () => {
    await withTestDatabase(async (pool) => {
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

      const owner = await auth.createAccount('owner', PW, 'owner@example.com')
      await markEmailVerified(db, owner.id)
      const player = await auth.createAccount('player', PW, 'player@example.com')
      const login = async (username: string): Promise<string> =>
        `cs_session=${
          (
            await app.inject({
              method: 'POST',
              url: '/api/login',
              payload: { username, password: PW },
            })
          ).cookies.find((c) => c.name === 'cs_session')?.value
        }`

      const ownerCookie = await login('owner')
      const worldId = (
        await app.inject({
          method: 'POST',
          url: '/api/worlds',
          headers: { cookie: ownerCookie },
          payload: { name: 'Private' },
        })
      ).json().world.slug as string
      await app.inject({
        method: 'POST',
        url: `/api/worlds/${worldId}/members`,
        headers: { cookie: ownerCookie },
        payload: { accountId: player.id },
      })
      const playerCookie = await login('player')

      // the player IS a member — requireWorld passes — and is still refused
      const asPlayer = await app.inject({
        method: 'GET',
        url: `/api/worlds/${worldId}/export`,
        headers: { cookie: playerCookie },
      })
      expect(asPlayer.statusCode).toBe(403)

      const asOwner = await app.inject({
        method: 'GET',
        url: `/api/worlds/${worldId}/export`,
        headers: { cookie: ownerCookie },
      })
      expect(asOwner.statusCode).toBe(200)
    })
  })
})
