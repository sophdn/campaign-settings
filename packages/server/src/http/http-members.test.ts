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

/** A world owned by `dm` with `zeb` and `abe` as players, plus a non-member `outsider`. */
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
  // Created zeb-then-abe so an insertion-ordered list would come out wrong —
  // the alphabetical assertion below would pass by accident otherwise.
  const zeb = await auth.createAccount('zeb', 'pw-123456')
  const abe = await auth.createAccount('abe', 'pw-123456')
  await auth.createAccount('outsider', 'pw-123456')

  const dm = await login(app, 'dm', 'pw-123456')
  const zebCookie = await login(app, 'zeb', 'pw-123456')
  const outsider = await login(app, 'outsider', 'pw-123456')

  const created = await app.inject({
    method: 'POST',
    url: '/api/worlds',
    headers: { cookie: dm },
    payload: { name: 'W' },
  })
  const worldId = created.json().world.slug as string
  for (const id of [zeb.id, abe.id]) {
    await app.inject({
      method: 'POST',
      url: `/api/worlds/${worldId}/members`,
      headers: { cookie: dm },
      payload: { accountId: id },
    })
  }
  return { app, dm, zeb: zebCookie, outsider, worldId, zebId: zeb.id, abeId: abe.id }
}

const listMembers = (
  app: FastifyInstance,
  worldId: string,
  cookie?: string,
): Promise<LightMyRequestResponse> =>
  app.inject({
    method: 'GET',
    url: `/api/worlds/${worldId}/members`,
    ...(cookie ? { headers: { cookie } } : {}),
  })

describe('member list', () => {
  it('returns the owner first, then players alphabetically, with roles and join times', async () => {
    await withTestDatabase(async (pool) => {
      const { app, dm, worldId } = await setup(pool)

      const res = await listMembers(app, worldId, dm)

      expect(res.statusCode).toBe(200)
      const members = res.json().members as { username: string; role: string; joinedAt: string }[]
      expect(members.map((m) => m.username)).toEqual(['dm', 'abe', 'zeb'])
      expect(members.map((m) => m.role)).toEqual(['owner', 'player', 'player'])
      expect(Date.parse(members[0]?.joinedAt ?? '')).not.toBeNaN()
    })
  })

  it('never exposes an email or a password hash', async () => {
    await withTestDatabase(async (pool) => {
      const { app, dm, worldId } = await setup(pool)

      const res = await listMembers(app, worldId, dm)

      const members = res.json().members as Record<string, unknown>[]
      expect(members.length).toBeGreaterThan(0)
      for (const m of members) {
        expect(Object.keys(m).sort()).toEqual(['accountId', 'joinedAt', 'role', 'username'])
      }
    })
  })

  it('is readable by a PLAYER — knowing who else is in the campaign is not owner-only', async () => {
    await withTestDatabase(async (pool) => {
      const { app, zeb, worldId } = await setup(pool)

      const res = await listMembers(app, worldId, zeb)

      expect(res.statusCode).toBe(200)
      expect((res.json().members as unknown[]).length).toBe(3)
    })
  })

  it('rejects a non-member', async () => {
    await withTestDatabase(async (pool) => {
      const { app, outsider, worldId } = await setup(pool)

      expect((await listMembers(app, worldId, outsider)).statusCode).toBe(403)
    })
  })

  it('rejects an anonymous caller', async () => {
    await withTestDatabase(async (pool) => {
      const { app, worldId } = await setup(pool)

      expect((await listMembers(app, worldId)).statusCode).toBe(401)
    })
  })

  it('drops a removed member from the list', async () => {
    await withTestDatabase(async (pool) => {
      const { app, dm, worldId, zebId } = await setup(pool)

      const removed = await app.inject({
        method: 'DELETE',
        url: `/api/worlds/${worldId}/members/${zebId}`,
        headers: { cookie: dm },
      })
      expect(removed.statusCode).toBe(200)

      const members = (await listMembers(app, worldId, dm)).json().members as {
        username: string
      }[]
      expect(members.map((m) => m.username)).toEqual(['dm', 'abe'])
    })
  })

  it('refuses a player trying to remove another member — the UI hiding it is not the gate', async () => {
    await withTestDatabase(async (pool) => {
      const { app, zeb, worldId, abeId } = await setup(pool)

      const res = await app.inject({
        method: 'DELETE',
        url: `/api/worlds/${worldId}/members/${abeId}`,
        headers: { cookie: zeb },
      })

      expect(res.statusCode).toBe(403)
    })
  })
})
