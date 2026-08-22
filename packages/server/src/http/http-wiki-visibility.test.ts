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
 * `GET /api/worlds/:worldId/wiki` is the corpus the `[[name]]` picker offers as
 * suggestions while an author types. That makes it a VISIBILITY surface, not
 * merely a convenience one: a name a player may not see must not reach them as
 * an autocomplete row, where it would leak the existence and the exact name of
 * a hidden entity without ever opening it.
 *
 * These assertions existed nowhere before the picker was built — the endpoint
 * was only ever consumed for link RESOLUTION of prose the reader could already
 * see, so nothing pinned what it returns per-actor.
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

const wikiNames = async (
  app: FastifyInstance,
  world: string,
  cookie: string,
): Promise<string[]> => {
  const res = await app.inject({
    method: 'GET',
    url: `/api/worlds/${world}/wiki`,
    headers: { cookie },
  })
  expect(res.statusCode).toBe(200)
  return (res.json() as { entries: { name: string }[] }).entries.map((e) => e.name).sort()
}

const addNpc = (
  app: FastifyInstance,
  world: string,
  cookie: string,
  name: string,
  visibility: string,
): Promise<unknown> =>
  app.inject({
    method: 'POST',
    url: `/api/worlds/${world}/entities/npc`,
    headers: { cookie },
    payload: { name, visibility },
  })

async function setup(pool: Pool) {
  const db = createDb(pool)
  await migrateToLatest(db)
  const auth = createScryptAuth(db)
  const app = buildApp({ db, auth, cookieSecret: SECRET, cookieSecure: false, flags: openFlags() })
  await app.ready()

  const dmAccount = await auth.createAccount('dm', PW, 'dm@example.com')
  await markEmailVerified(db, dmAccount.id)
  const playerAccount = await auth.createAccount('player', PW, 'player@example.com')

  const dm = await login(app, 'dm')
  const player = await login(app, 'player')

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

  await addNpc(app, world, dm, 'Public Bartender', 'public')
  await addNpc(app, world, dm, 'The Hollow Man', 'dm_only')
  await addNpc(app, world, dm, 'Silas Crow', 'restricted')

  return { app, db, dm, player, world, playerAccount }
}

describe('wiki corpus (the picker’s suggestion source) is visibility-filtered', () => {
  it('gives the owner every entity', async () => {
    await withTestDatabase(async (pool) => {
      const { app, world, dm } = await setup(pool)
      expect(await wikiNames(app, world, dm)).toEqual([
        'Public Bartender',
        'Silas Crow',
        'The Hollow Man',
      ])
    })
  })

  it('withholds dm_only and ungranted restricted names from a player', async () => {
    await withTestDatabase(async (pool) => {
      const { app, world, player } = await setup(pool)
      // The names themselves must be absent — not merely unopenable. A picker
      // row is the name, so leaking it here leaks the secret.
      expect(await wikiNames(app, world, player)).toEqual(['Public Bartender'])
    })
  })

  it('reveals a restricted name only once that player holds a grant', async () => {
    await withTestDatabase(async (pool) => {
      const { app, world, dm, player, playerAccount } = await setup(pool)
      const entries = (
        (
          await app.inject({
            method: 'GET',
            url: `/api/worlds/${world}/wiki`,
            headers: { cookie: dm },
          })
        ).json() as { entries: { id: string; name: string; kind: string }[] }
      ).entries
      const silas = entries.find((e) => e.name === 'Silas Crow')!

      await app.inject({
        method: 'POST',
        url: `/api/worlds/${world}/entities/npc/${silas.id}/grants`,
        headers: { cookie: dm },
        payload: { accountId: playerAccount.id },
      })

      expect(await wikiNames(app, world, player)).toEqual(['Public Bartender', 'Silas Crow'])
    })
  })

  it('never reaches across worlds', async () => {
    await withTestDatabase(async (pool) => {
      const { app, dm } = await setup(pool)
      const other = await app.inject({
        method: 'POST',
        url: '/api/worlds',
        headers: { cookie: dm },
        payload: { name: 'Elsewhere' },
      })
      const otherWorld = other.json().world.slug as string
      await addNpc(app, otherWorld, dm, 'Foreign Duke', 'public')

      // Same owner, different world: the corpus is per-world, so a picker in one
      // campaign can never suggest a name out of another.
      expect(await wikiNames(app, otherWorld, dm)).toEqual(['Foreign Duke'])
    })
  })

  it('refuses a non-member outright', async () => {
    await withTestDatabase(async (pool) => {
      const { app, db, world } = await setup(pool)
      await createScryptAuth(db).createAccount('stranger', PW, 'stranger@example.com')
      const stranger = await login(app, 'stranger')
      const res = await app.inject({
        method: 'GET',
        url: `/api/worlds/${world}/wiki`,
        headers: { cookie: stranger },
      })
      expect(res.statusCode).toBe(403)
    })
  })
})
