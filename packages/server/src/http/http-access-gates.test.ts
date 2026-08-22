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
 * The gate suite: every surface 3630 names, asserted in BOTH flag states.
 *
 * The point of each pair is that the refusal is SERVER-side. The SPA routes a
 * `surface_disabled` code to the contact modal, but a script does not read the
 * SPA — so what makes the flag real is the 403 here.
 */
/** Another app over the SAME database, evaluated against different flags. */
async function appWith(pool: Pool, flags: FeatureFlags): Promise<FastifyInstance> {
  const db = createDb(pool)
  const app = buildApp({
    db,
    auth: createScryptAuth(db),
    cookieSecret: SECRET,
    cookieSecure: false,
    flags,
  })
  await app.ready()
  return app
}

/**
 * Migrate, seed `dm` (verified) and `player`, and hand back BOTH an app with
 * everything open and a factory for gated ones. Sessions are minted through the
 * open app so a suite can act as a signed-in user even while login is gated
 * off — which is the only way to test what a logged-in visitor hits.
 */
async function setup(pool: Pool, flags: FeatureFlags) {
  const db = createDb(pool)
  await migrateToLatest(db)
  const auth = createScryptAuth(db)
  const dm = await auth.createAccount('dm', PW, 'dm@example.com')
  const player = await auth.createAccount('player', PW, 'player@example.com')
  await markEmailVerified(db, dm.id)

  const open = await appWith(pool, openFlags())
  const app = await appWith(pool, flags)

  const sessionFor = async (username: string): Promise<string> => {
    const res = await open.inject({
      method: 'POST',
      url: '/api/login',
      payload: { username, password: PW },
    })
    return `cs_session=${res.cookies.find((c) => c.name === 'cs_session')?.value}`
  }

  return { app, open, db, auth, sessionFor, dmId: dm.id, playerId: player.id }
}

const expectDisabled = (res: LightMyRequestResponse): void => {
  expect(res.statusCode).toBe(403)
  expect(res.json().error.code).toBe('surface_disabled')
}

describe('gate: login', () => {
  it('refuses server-side when off', async () => {
    await withTestDatabase(async (pool) => {
      const { app } = await setup(pool, allFlags(false))
      expectDisabled(
        await app.inject({
          method: 'POST',
          url: '/api/login',
          payload: { username: 'dm', password: PW },
        }),
      )
    })
  })

  it('runs the real flow unchanged when on', async () => {
    await withTestDatabase(async (pool) => {
      const { app } = await setup(pool, openFlags())
      const res = await app.inject({
        method: 'POST',
        url: '/api/login',
        payload: { username: 'dm', password: PW },
      })
      expect(res.statusCode).toBe(200)
      expect(res.cookies.some((c) => c.name === 'cs_session')).toBe(true)
    })
  })

  it('is refused BEFORE the credentials are judged — the gate is not a wrong-password oracle', async () => {
    await withTestDatabase(async (pool) => {
      const { app } = await setup(pool, allFlags(false))
      const wrong = await app.inject({
        method: 'POST',
        url: '/api/login',
        payload: { username: 'dm', password: 'not-the-password' },
      })
      // identical to the right password: the gate answers first
      expectDisabled(wrong)
    })
  })
})

describe('gate: password reset', () => {
  it('refuses both halves server-side when off', async () => {
    await withTestDatabase(async (pool) => {
      const { app } = await setup(pool, allFlags(false))
      expectDisabled(
        await app.inject({
          method: 'POST',
          url: '/api/password-reset/request',
          payload: { identifier: 'dm' },
        }),
      )
      expectDisabled(
        await app.inject({
          method: 'POST',
          url: '/api/password-reset/confirm',
          payload: { token: 'whatever', newPassword: 'new-password-1' },
        }),
      )
    })
  })

  it('runs the real flow when on', async () => {
    await withTestDatabase(async (pool) => {
      const { app } = await setup(pool, openFlags())
      // the request half always answers 200 — anti-enumeration, unchanged
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/password-reset/request',
            payload: { identifier: 'dm' },
          })
        ).statusCode,
      ).toBe(200)
    })
  })
})

describe('gate: player-to-GM suggestions', () => {
  async function worldWithPlayer(pool: Pool, flags: FeatureFlags) {
    const { app: gated, open: opener, sessionFor, playerId } = await setup(pool, flags)
    const dm = await sessionFor('dm')
    const player = await sessionFor('player')
    const created = await opener.inject({
      method: 'POST',
      url: '/api/worlds',
      headers: { cookie: dm },
      payload: { name: 'W' },
    })
    const worldId = created.json().world.slug as string
    await opener.inject({
      method: 'POST',
      url: `/api/worlds/${worldId}/members`,
      headers: { cookie: dm },
      payload: { accountId: playerId },
    })
    return { gated, opener, worldId, player, dm }
  }

  it('refuses a proposal server-side when off', async () => {
    await withTestDatabase(async (pool) => {
      const { gated, worldId, player } = await worldWithPlayer(pool, allFlags(false))
      expectDisabled(
        await gated.inject({
          method: 'POST',
          url: `/api/worlds/${worldId}/suggestions`,
          headers: { cookie: player },
          payload: { targetKind: 'npc', targetId: 'nope', proposed: { name: 'x' } },
        }),
      )
    })
  })

  it('leaves the GM side of the queue alone — accept/reject are not gated', async () => {
    await withTestDatabase(async (pool) => {
      const { gated, worldId, dm } = await worldWithPlayer(pool, allFlags(false))
      // 404 (no such suggestion), NOT 403 — the route is reachable, which is
      // the point: gating it would strand anything already in the queue.
      const res = await gated.inject({
        method: 'POST',
        url: `/api/worlds/${worldId}/suggestions/no-such-id/accept`,
        headers: { cookie: dm },
      })
      expect(res.statusCode).toBe(404)
    })
  })

  it('lets a player propose when on', async () => {
    await withTestDatabase(async (pool) => {
      const { gated, opener, worldId, player, dm } = await worldWithPlayer(pool, openFlags())
      const npc = await opener.inject({
        method: 'POST',
        url: `/api/worlds/${worldId}/entities/npc`,
        headers: { cookie: dm },
        payload: { name: 'Target' },
      })
      const res = await gated.inject({
        method: 'POST',
        url: `/api/worlds/${worldId}/suggestions`,
        headers: { cookie: player },
        payload: {
          targetKind: 'npc',
          targetId: npc.json().entity.id,
          proposed: { name: 'Renamed' },
        },
      })
      expect(res.statusCode).toBe(201)
    })
  })
})

/**
 * The hazard this task exists to close. Task 3631's demo auto-login puts EVERY
 * visitor on one SHARED account, so an open /account page lets any visitor
 * change the shared password and lock out everyone else — including the seeded
 * e2e flows. The gate is a preHandler on the whole family, so the assertion
 * that matters is that NO route in it is reachable.
 */
describe('gate: account management', () => {
  const ACCOUNT_ROUTES: { method: 'GET' | 'POST' | 'DELETE'; url: string; payload?: unknown }[] = [
    {
      method: 'POST',
      url: '/api/account/password',
      payload: { currentPassword: PW, newPassword: 'new-password-1' },
    },
    { method: 'POST', url: '/api/account/username', payload: { username: 'renamed' } },
    { method: 'GET', url: '/api/account/sessions' },
    { method: 'POST', url: '/api/account/sessions/revoke-all' },
    { method: 'GET', url: '/api/account/status' },
    { method: 'POST', url: '/api/account/verification/resend' },
    { method: 'GET', url: '/api/account/deletion-blockers' },
    { method: 'DELETE', url: '/api/account', payload: { password: PW } },
  ]

  it('refuses EVERY route in the family when off', async () => {
    await withTestDatabase(async (pool) => {
      const { app: gated, sessionFor } = await setup(pool, allFlags(false))
      const cookie = await sessionFor('dm')

      for (const route of ACCOUNT_ROUTES) {
        const res = await gated.inject({
          method: route.method,
          url: route.url,
          headers: { cookie },
          ...(route.payload ? { payload: route.payload } : {}),
        })
        expect(res.statusCode, `${route.method} ${route.url}`).toBe(403)
        expect(res.json().error.code, `${route.method} ${route.url}`).toBe('surface_disabled')
      }
    })
  })

  it('serves every route in the family when on', async () => {
    await withTestDatabase(async (pool) => {
      const { app, sessionFor } = await setup(pool, openFlags())
      const cookie = await sessionFor('dm')

      expect(
        (await app.inject({ method: 'GET', url: '/api/account/sessions', headers: { cookie } }))
          .statusCode,
      ).toBe(200)
      expect(
        (await app.inject({ method: 'GET', url: '/api/account/status', headers: { cookie } }))
          .statusCode,
      ).toBe(200)
      expect(
        (
          await app.inject({
            method: 'GET',
            url: '/api/account/deletion-blockers',
            headers: { cookie },
          })
        ).statusCode,
      ).toBe(200)
    })
  })

  it('still demands a session when on — the flag opens the surface, not the door', async () => {
    await withTestDatabase(async (pool) => {
      const { app } = await setup(pool, openFlags())
      expect((await app.inject({ method: 'GET', url: '/api/account/sessions' })).statusCode).toBe(
        401,
      )
    })
  })
})

describe('gate: signup', () => {
  it('refuses when off and creates when on', async () => {
    await withTestDatabase(async (pool) => {
      const { app: closed, open } = await setup(pool, allFlags(false))
      const payload = { username: 'newbie', password: PW, email: 'newbie@example.com' }
      const refused = await closed.inject({ method: 'POST', url: '/api/register', payload })
      expect(refused.statusCode).toBe(403)
      // signup keeps its OWN code — it predates this task and the SPA already
      // maps it; re-labelling it would break the registration page's copy.
      expect(refused.json().error.code).toBe('signup_closed')

      expect(
        (await open.inject({ method: 'POST', url: '/api/register', payload })).statusCode,
      ).toBe(201)
    })
  })
})
