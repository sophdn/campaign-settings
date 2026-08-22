import type { FastifyInstance } from 'fastify'
import type { Pool } from 'pg'
import { describe, expect, it } from 'vitest'
import { createScryptAuth } from '../auth/service'
import type { WorldDashboard } from '../data/dashboard'
import { createDb } from '../db/kysely'
import { migrateToLatest } from '../db/migrator'
import { markEmailVerified, withTestDatabase } from '../db/test-database'
import { openFlags } from '../flags/config'
import { buildApp } from './app'

const SECRET = 'test-secret-test-secret-test-secret'
const PW = 'pw-123456'

/**
 * `GET /api/worlds/:worldId/dashboard` is the world root — the first screen a
 * viewer sees. It is a visibility surface in the same sense the wiki corpus is:
 * a session name, a character name or a count that a player may not have is a
 * leak whether or not the page it names can be opened.
 *
 * These assertions pin the endpoint's PER-ACTOR answer. The composition itself
 * is covered at the data layer (data/dashboard.test.ts); what is proved here is
 * that the route hands each caller their own filtered view and refuses anyone
 * who is not a member at all.
 */
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

async function dashboardOf(
  app: FastifyInstance,
  world: string,
  cookie: string,
): Promise<WorldDashboard> {
  const res = await app.inject({
    method: 'GET',
    url: `/api/worlds/${world}/dashboard`,
    headers: { cookie },
  })
  expect(res.statusCode).toBe(200)
  return (res.json() as { dashboard: WorldDashboard }).dashboard
}

async function setup(pool: Pool) {
  const db = createDb(pool)
  await migrateToLatest(db)
  const auth = createScryptAuth(db)
  const app = buildApp({ db, auth, cookieSecret: SECRET, cookieSecure: false, flags: openFlags() })
  await app.ready()

  const dmAccount = await auth.createAccount('dm', PW, 'dm@example.com')
  await markEmailVerified(db, dmAccount.id)
  const playerAccount = await auth.createAccount('rowan', PW, 'rowan@example.com')

  const dm = await login(app, 'dm')
  const player = await login(app, 'rowan')

  const created = await app.inject({
    method: 'POST',
    url: '/api/worlds',
    headers: { cookie: dm },
    payload: { name: 'Saltmarsh' },
  })
  const world = created.json().world.slug as string
  await app.inject({
    method: 'POST',
    url: `/api/worlds/${world}/members`,
    headers: { cookie: dm },
    payload: { accountId: playerAccount.id },
  })

  return { app, db, dm, player, world, playerAccount }
}

describe('the world dashboard endpoint', () => {
  it('answers a brand-new world with empty panels rather than an error', async () => {
    await withTestDatabase(async (pool) => {
      const { app, world, dm } = await setup(pool)
      const d = await dashboardOf(app, world, dm)
      expect(d.session).toBeNull()
      expect(d.party).toEqual([])
      expect(d.myCharacter).toBeNull()
      expect(d.counts.npc).toBe(0)
    })
  })

  it('gives the GM the party with each character’s player named', async () => {
    await withTestDatabase(async (pool) => {
      const { app, world, dm, playerAccount } = await setup(pool)
      await app.inject({
        method: 'POST',
        url: `/api/worlds/${world}/entities/pc`,
        headers: { cookie: dm },
        payload: { name: 'Bright', visibility: 'public', account_id: playerAccount.id },
      })

      const d = await dashboardOf(app, world, dm)
      expect(d.party).toEqual([
        {
          id: expect.any(String),
          name: 'Bright',
          accountId: playerAccount.id,
          playerName: 'rowan',
        },
      ])
    })
  })

  it('resolves the player’s own character through the link the GM set', async () => {
    await withTestDatabase(async (pool) => {
      const { app, world, dm, player, playerAccount } = await setup(pool)
      await app.inject({
        method: 'POST',
        url: `/api/worlds/${world}/entities/pc`,
        headers: { cookie: dm },
        payload: { name: 'Bright', visibility: 'public', account_id: playerAccount.id },
      })

      expect((await dashboardOf(app, world, player)).myCharacter?.name).toBe('Bright')
      // The GM plays nobody here, so their own-character slot stays empty.
      expect((await dashboardOf(app, world, dm)).myCharacter).toBeNull()
    })
  })

  it('withholds a dm_only session and its count from a player', async () => {
    await withTestDatabase(async (pool) => {
      const { app, world, dm, player } = await setup(pool)
      await app.inject({
        method: 'POST',
        url: `/api/worlds/${world}/entities/session`,
        headers: { cookie: dm },
        payload: { name: 'The secret one', visibility: 'dm_only' },
      })

      expect((await dashboardOf(app, world, dm)).session?.name).toBe('The secret one')
      const playerView = await dashboardOf(app, world, player)
      expect(playerView.session).toBeNull()
      expect(playerView.counts.session).toBe(0)
    })
  })

  it('refuses a non-member outright, like every other world surface', async () => {
    await withTestDatabase(async (pool) => {
      const { app, db, world } = await setup(pool)
      await createScryptAuth(db).createAccount('stranger', PW, 'stranger@example.com')
      const stranger = await login(app, 'stranger')
      const res = await app.inject({
        method: 'GET',
        url: `/api/worlds/${world}/dashboard`,
        headers: { cookie: stranger },
      })
      expect(res.statusCode).toBe(403)
    })
  })
})
