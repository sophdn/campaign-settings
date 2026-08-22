import type { FastifyInstance } from 'fastify'
import type { Pool } from 'pg'
import { describe, expect, it } from 'vitest'
import { createScryptAuth } from '../auth/service'
import { createDb } from '../db/kysely'
import { migrateToLatest } from '../db/migrator'
import { withTestDatabase } from '../db/test-database'
import { openFlags } from '../flags/config'
import { buildApp } from './app'

/**
 * The PC → player link, over HTTP.
 *
 * `data/pc-account.test.ts` proves the RULES against a real Postgres, but it
 * calls the guard directly — so it sees `PcAccountLinkError` and never a status
 * code. This file covers the two seams between that guard and the GM:
 *
 *  1. The route actually calls it, on BOTH create and patch. A rule wired into
 *     one verb and not the other is the ordinary way this breaks.
 *  2. `PcAccountLinkError` maps to 400 `invalid_pc_account`. Without that entry
 *     in the error map, the whole reason the guard exists — a readable refusal
 *     instead of the unique index's 500 — silently does not happen.
 *
 * Both were unasserted until this file existed.
 */

const SECRET = 'test-secret-test-secret-test-secret'
const PW = 'pw-123456'

interface Harness {
  app: FastifyInstance
  slug: string
  dm: string
  player: string
  playerId: string
  otherId: string
  strangerId: string
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
    try {
      await auth.createAccount('dm', PW)
      const playerAccount = await auth.createAccount('player', PW)
      const otherAccount = await auth.createAccount('other', PW)
      // In no world at all — the "invite them first" case.
      const strangerAccount = await auth.createAccount('stranger', PW)
      const dm = await login(app, 'dm')
      const world = await app.inject({
        method: 'POST',
        url: '/api/worlds',
        headers: { cookie: dm },
        payload: { name: 'W' },
      })
      const slug = world.json().world.slug as string
      for (const id of [playerAccount.id, otherAccount.id]) {
        await app.inject({
          method: 'POST',
          url: `/api/worlds/${slug}/members`,
          headers: { cookie: dm },
          payload: { accountId: id },
        })
      }
      await body({
        app,
        slug,
        dm,
        player: await login(app, 'player'),
        playerId: playerAccount.id,
        otherId: otherAccount.id,
        strangerId: strangerAccount.id,
      })
    } finally {
      await app.close()
    }
  })
}

const createPc = (h: Harness, payload: Record<string, unknown>) =>
  h.app.inject({
    method: 'POST',
    url: `/api/worlds/${h.slug}/entities/pc`,
    headers: { cookie: h.dm },
    payload,
  })

const patchPc = (h: Harness, id: string, payload: Record<string, unknown>, cookie?: string) =>
  h.app.inject({
    method: 'PATCH',
    url: `/api/worlds/${h.slug}/entities/pc/${id}`,
    headers: { cookie: cookie ?? h.dm },
    payload,
  })

describe('the PC → player link over HTTP', () => {
  it('answers 400 invalid_pc_account for a non-member, on create AND on patch', async () => {
    await withHarness(async (h) => {
      const onCreate = await createPc(h, { name: 'Roland', account_id: h.strangerId })
      expect(onCreate.statusCode).toBe(400)
      expect(onCreate.json().error.code).toBe('invalid_pc_account')
      expect(onCreate.json().error.message).toMatch(/member of this world/)

      const pc = await createPc(h, { name: 'Roland' })
      const onPatch = await patchPc(h, pc.json().entity.id as string, {
        account_id: h.strangerId,
      })
      expect(onPatch.statusCode).toBe(400)
      expect(onPatch.json().error.code).toBe('invalid_pc_account')
    })
  })

  it('answers 400 — not 500 — when a player already holds a character', async () => {
    // The regression that matters: the rule is a partial unique index, so
    // WITHOUT the route calling the guard this is a constraint violation and
    // the GM gets "internal error". 500 here means the wiring is gone even
    // though the rule still holds.
    await withHarness(async (h) => {
      const first = await createPc(h, { name: 'Roland', account_id: h.playerId })
      expect(first.statusCode).toBe(201)

      const second = await createPc(h, { name: 'Roland II', account_id: h.playerId })
      expect(second.statusCode).toBe(400)
      expect(second.json().error.code).toBe('invalid_pc_account')
      // Names the player and the character holding the seat, so the GM knows
      // what to clear.
      expect(second.json().error.message).toMatch(/player already plays Roland/)
    })
  })

  it('accepts a member, and re-saving the same pair is not a conflict', async () => {
    await withHarness(async (h) => {
      const created = await createPc(h, { name: 'Roland', account_id: h.playerId })
      expect(created.statusCode).toBe(201)
      const id = created.json().entity.id as string

      // `selfId` is what keeps a no-op edit from reporting itself as the
      // duplicate. Without it, saving an unchanged character would 400.
      const again = await patchPc(h, id, { account_id: h.playerId, name: 'Roland' })
      expect(again.statusCode).toBe(200)
      expect(again.json().entity.account_id).toBe(h.playerId)
    })
  })

  it('lets the GM move a character to a different player, and frees the old seat', async () => {
    await withHarness(async (h) => {
      const created = await createPc(h, { name: 'Roland', account_id: h.playerId })
      const id = created.json().entity.id as string

      const moved = await patchPc(h, id, { account_id: h.otherId })
      expect(moved.statusCode).toBe(200)
      expect(moved.json().entity.account_id).toBe(h.otherId)

      // The first player's seat is free again, so a new character can take it.
      const successor = await createPc(h, { name: 'Successor', account_id: h.playerId })
      expect(successor.statusCode).toBe(201)
    })
  })

  it('clears the link on null, and the page keeps everything else', async () => {
    await withHarness(async (h) => {
      const created = await createPc(h, {
        name: 'Roland',
        description: 'A knight of the bridge.',
        account_id: h.playerId,
      })
      const id = created.json().entity.id as string

      const cleared = await patchPc(h, id, { account_id: null })
      expect(cleared.statusCode).toBe(200)
      expect(cleared.json().entity.account_id).toBeNull()
      expect(cleared.json().entity.description).toBe('A knight of the bridge.')
    })
  })

  it('refuses a player 403, before the link rules are ever consulted', async () => {
    await withHarness(async (h) => {
      const created = await createPc(h, { name: 'Roland', account_id: h.playerId })
      const id = created.json().entity.id as string

      // Their OWN character, and still refused: content writes are owner-only
      // and the link is content. 403, not the 400 a rule violation earns.
      const res = await patchPc(h, id, { account_id: h.playerId }, h.player)
      expect(res.statusCode).toBe(403)
    })
  })
})
