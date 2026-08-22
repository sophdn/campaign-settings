import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FastifyInstance, LightMyRequestResponse } from 'fastify'
import type { Pool } from 'pg'
import { describe, expect, it } from 'vitest'
import { createScryptAuth } from '../auth/service'
import { createDb } from '../db/kysely'
import { migrateToLatest } from '../db/migrator'
import { withTestDatabase } from '../db/test-database'
import { openFlags } from '../flags/config'
import { buildApp } from './app'

/**
 * The trash routes over HTTP.
 *
 * `data/trash.test.ts` proves the behaviour; this suite proves the DOORS —
 * that the player is refused at every one of the three, that the two mutations
 * answer 404 rather than success for anything not in this world's trash, and
 * that the round trip a person actually performs (delete, find it, put it back)
 * works through the API the SPA calls.
 */

const SECRET = 'test-secret-test-secret-test-secret'
const PW = 'pw-123456'

interface Harness {
  app: FastifyInstance
  slug: string
  dm: string
  player: string
  npcId: string
}

async function login(app: FastifyInstance, username: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/login',
    payload: { username, password: PW },
  })
  return `cs_session=${res.cookies.find((x) => x.name === 'cs_session')!.value}`
}

async function withHarness(body: (h: Harness) => Promise<void>): Promise<void> {
  await withTestDatabase(async (pool: Pool) => {
    const uploadsDir = mkdtempSync(join(tmpdir(), 'cs-trash-'))
    const db = createDb(pool)
    await migrateToLatest(db)
    const auth = createScryptAuth(db)
    const app = buildApp({
      db,
      auth,
      cookieSecret: SECRET,
      cookieSecure: false,
      flags: openFlags(),
      uploadsDir,
    })
    await app.ready()
    try {
      await auth.createAccount('dm', PW)
      const playerAccount = await auth.createAccount('player', PW)
      const dm = await login(app, 'dm')

      const world = await app.inject({
        method: 'POST',
        url: '/api/worlds',
        headers: { cookie: dm },
        payload: { name: 'W' },
      })
      const slug = world.json().world.slug as string
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
        payload: { name: 'The Harbourmaster', visibility: 'public' },
      })

      await body({
        app,
        slug,
        dm,
        player: await login(app, 'player'),
        npcId: npc.json().entity.id as string,
      })
    } finally {
      await app.close()
      rmSync(uploadsDir, { recursive: true, force: true })
    }
  })
}

const call = (
  h: Harness,
  method: 'GET' | 'POST' | 'DELETE',
  url: string,
  cookie: string,
): Promise<LightMyRequestResponse> =>
  h.app.inject({ method, url: `/api/worlds/${h.slug}${url}`, headers: { cookie } })

describe('trash routes', () => {
  it('a deleted entity is listed, restored, and gone from the trash again', async () => {
    await withHarness(async (h) => {
      expect((await call(h, 'GET', '/trash', h.dm)).json().entries).toEqual([])

      expect((await call(h, 'DELETE', `/entities/npc/${h.npcId}`, h.dm)).statusCode).toBe(200)
      const listed = (await call(h, 'GET', '/trash', h.dm)).json().entries
      expect(listed).toMatchObject([{ kind: 'npc', id: h.npcId, name: 'The Harbourmaster' }])
      expect(listed[0].deleted_at).toBeTruthy()

      expect((await call(h, 'POST', `/trash/npc/${h.npcId}/restore`, h.dm)).statusCode).toBe(200)
      expect((await call(h, 'GET', '/trash', h.dm)).json().entries).toEqual([])
      // and it is a live entity again, not merely absent from the trash
      expect((await call(h, 'GET', `/entities/npc/${h.npcId}`, h.dm)).statusCode).toBe(200)
    })
  })

  it('refuses a player at all three doors', async () => {
    await withHarness(async (h) => {
      await call(h, 'DELETE', `/entities/npc/${h.npcId}`, h.dm)

      expect((await call(h, 'GET', '/trash', h.player)).statusCode).toBe(403)
      expect((await call(h, 'POST', `/trash/npc/${h.npcId}/restore`, h.player)).statusCode).toBe(
        403,
      )
      expect((await call(h, 'DELETE', `/trash/npc/${h.npcId}`, h.player)).statusCode).toBe(403)
      // the refusals were real: it is still in the trash, and still deleted
      expect((await call(h, 'GET', '/trash', h.dm)).json().entries).toHaveLength(1)
    })
  })

  it('404s rather than succeeding for anything that is not in this trash', async () => {
    await withHarness(async (h) => {
      // A LIVE entity. Purging it must not work, or one mistyped request would
      // be permanent loss with no intermediate state to catch it.
      expect((await call(h, 'DELETE', `/trash/npc/${h.npcId}`, h.dm)).statusCode).toBe(404)
      expect((await call(h, 'POST', `/trash/npc/${h.npcId}/restore`, h.dm)).statusCode).toBe(404)

      await call(h, 'DELETE', `/entities/npc/${h.npcId}`, h.dm)
      // The right id under the WRONG kind, which is the case a confirmation
      // dialog cannot catch, because the owner is looking at a different row.
      expect((await call(h, 'DELETE', `/trash/species/${h.npcId}`, h.dm)).statusCode).toBe(404)
      expect((await call(h, 'POST', `/trash/species/${h.npcId}/restore`, h.dm)).statusCode).toBe(
        404,
      )
      expect((await call(h, 'DELETE', '/trash/npc/no-such-id', h.dm)).statusCode).toBe(404)
      expect((await call(h, 'GET', '/trash', h.dm)).json().entries).toHaveLength(1)
    })
  })

  it('a purge is permanent, and the entity does not come back', async () => {
    await withHarness(async (h) => {
      await call(h, 'DELETE', `/entities/npc/${h.npcId}`, h.dm)
      expect((await call(h, 'DELETE', `/trash/npc/${h.npcId}`, h.dm)).statusCode).toBe(200)

      expect((await call(h, 'GET', '/trash', h.dm)).json().entries).toEqual([])
      expect((await call(h, 'GET', `/entities/npc/${h.npcId}`, h.dm)).statusCode).toBe(404)
      // A second purge is a miss, not an error and not a success.
      expect((await call(h, 'DELETE', `/trash/npc/${h.npcId}`, h.dm)).statusCode).toBe(404)
    })
  })
})
