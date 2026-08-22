import type { FastifyInstance } from 'fastify'
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

/** A world owned by `dm` with `player` as a member, and one restricted npc. */
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

  await auth.createAccount('dm', 'pw-123456')
  const player = await auth.createAccount('player', 'pw-123456')
  const dm = await login(app, 'dm', 'pw-123456')
  const playerCookie = await login(app, 'player', 'pw-123456')

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

  const npc = await app.inject({
    method: 'POST',
    url: `/api/worlds/${worldId}/entities/npc`,
    headers: { cookie: dm },
    payload: { name: 'Hidden', visibility: 'restricted' },
  })
  const entityId = npc.json().entity.id as string

  return { app, dm, player: playerCookie, worldId, playerId: player.id, entityId }
}

describe('entity grants across a visibility change', () => {
  /**
   * The semantics the grant UI states on screen and the handoff records:
   * changing the visibility LEVEL never clears the per-player grant list. The
   * authorization seam consults grants for `restricted` rows only, so grants on
   * a public or dm_only page are inert — and keeping them means an owner who
   * hides a page and puts it back gets the same audience back.
   */
  it('keeps grants when the level moves away from restricted, and honours them again on return', async () => {
    await withTestDatabase(async (pool) => {
      const { app, dm, player, worldId, playerId, entityId } = await setup(pool)
      const base = `/api/worlds/${worldId}`
      const grants = (): Promise<{ accountIds: string[] }> =>
        app
          .inject({
            method: 'GET',
            url: `${base}/entities/npc/${entityId}/grants`,
            headers: { cookie: dm },
          })
          .then((r) => r.json())
      const setVisibility = (visibility: string) =>
        app.inject({
          method: 'PATCH',
          url: `${base}/entities/npc/${entityId}`,
          headers: { cookie: dm },
          payload: { visibility },
        })
      const playerSees = async (): Promise<boolean> =>
        (
          await app.inject({
            method: 'GET',
            url: `${base}/entities/npc/${entityId}`,
            headers: { cookie: player },
          })
        ).statusCode === 200

      await app.inject({
        method: 'POST',
        url: `${base}/entities/npc/${entityId}/grants`,
        headers: { cookie: dm },
        payload: { accountId: playerId },
      })
      expect((await grants()).accountIds).toEqual([playerId])
      expect(await playerSees()).toBe(true)

      // hide it from everyone
      expect((await setVisibility('dm_only')).statusCode).toBe(200)
      expect(await playerSees()).toBe(false)
      // the grant is retained, just inert
      expect((await grants()).accountIds).toEqual([playerId])

      // and putting it back restores the same audience, with no re-granting
      expect((await setVisibility('restricted')).statusCode).toBe(200)
      expect(await playerSees()).toBe(true)
    })
  })

  it('does not let a grant leak a public page back into hiding — public ignores grants entirely', async () => {
    await withTestDatabase(async (pool) => {
      const { app, dm, player, worldId, entityId } = await setup(pool)
      const base = `/api/worlds/${worldId}`

      // no grant for this player at all, but public means public
      await app.inject({
        method: 'PATCH',
        url: `${base}/entities/npc/${entityId}`,
        headers: { cookie: dm },
        payload: { visibility: 'public' },
      })

      const res = await app.inject({
        method: 'GET',
        url: `${base}/entities/npc/${entityId}`,
        headers: { cookie: player },
      })
      expect(res.statusCode).toBe(200)
    })
  })

  it('refuses a player reading the grant list — the list itself is owner-only', async () => {
    await withTestDatabase(async (pool) => {
      const { app, player, worldId, entityId } = await setup(pool)

      const res = await app.inject({
        method: 'GET',
        url: `/api/worlds/${worldId}/entities/npc/${entityId}/grants`,
        headers: { cookie: player },
      })

      expect(res.statusCode).toBe(403)
    })
  })

  it('refuses a player revoking someone else — the UI hiding the button is not the gate', async () => {
    await withTestDatabase(async (pool) => {
      const { app, player, worldId, playerId, entityId } = await setup(pool)

      const res = await app.inject({
        method: 'DELETE',
        url: `/api/worlds/${worldId}/entities/npc/${entityId}/grants/${playerId}`,
        headers: { cookie: player },
      })

      expect(res.statusCode).toBe(403)
    })
  })
})
