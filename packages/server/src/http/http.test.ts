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
  return `cs_session=${c!.value}`
}

/** App with a DM + a granted player, a world, and both auth cookies. */
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
  // routes are keyed by the world's slug (the URL key), not its opaque id
  const worldId = created.json().world.slug as string
  await app.inject({
    method: 'POST',
    url: `/api/worlds/${worldId}/members`,
    headers: { cookie: dm },
    payload: { accountId: player.id },
  })
  return { app, db, dm, player: playerCookie, playerId: player.id, worldId }
}

describe('http auth + worlds', () => {
  it('gates on the session cookie and validates input', async () => {
    await withTestDatabase(async (pool) => {
      const { app, dm } = await setup(pool)
      try {
        // health probe needs neither auth nor a session
        const health = await app.inject({ method: 'GET', url: '/api/health' })
        expect(health.statusCode).toBe(200)
        expect(health.json()).toEqual({ status: 'ok' })
        // unauthenticated
        const me0 = await app.inject({ method: 'GET', url: '/api/me' })
        expect(me0.statusCode).toBe(401)
        expect(me0.json()).toEqual({
          error: { code: 'unauthenticated', message: expect.any(String) },
        })
        // authenticated
        expect(
          (await app.inject({ method: 'GET', url: '/api/me', headers: { cookie: dm } })).statusCode,
        ).toBe(200)
        // bad credentials
        const bad = await app.inject({
          method: 'POST',
          url: '/api/login',
          payload: { username: 'dm', password: 'nope' },
        })
        expect(bad.statusCode).toBe(401)
        expect(bad.json().error.code).toBe('invalid_credentials')
        // validation failure → 400 with details
        const invalid = await app.inject({
          method: 'POST',
          url: '/api/login',
          payload: { username: 'dm' },
        })
        expect(invalid.statusCode).toBe(400)
        expect(invalid.json().error.code).toBe('invalid_request')
        // logout
        expect(
          (await app.inject({ method: 'POST', url: '/api/logout', headers: { cookie: dm } }))
            .statusCode,
        ).toBe(200)
      } finally {
        await app.close()
      }
    })
  })

  it('lists/creates worlds and refuses non-members', async () => {
    await withTestDatabase(async (pool) => {
      const { app, dm, worldId } = await setup(pool)
      try {
        const list = await app.inject({
          method: 'GET',
          url: '/api/worlds',
          headers: { cookie: dm },
        })
        expect(list.json().worlds).toHaveLength(1)
        expect(
          (
            await app.inject({
              method: 'GET',
              url: `/api/worlds/${worldId}`,
              headers: { cookie: dm },
            })
          ).statusCode,
        ).toBe(200)

        // a stranger (no membership) is forbidden
        const auth2 = createScryptAuth(createDb(pool))
        await auth2.createAccount('stranger', 'pw-123456')
        const strangerCookie = await login(app, 'stranger', 'pw-123456')
        const denied = await app.inject({
          method: 'GET',
          url: `/api/worlds/${worldId}`,
          headers: { cookie: strangerCookie },
        })
        expect(denied.statusCode).toBe(403)
        expect(denied.json().error.code).toBe('forbidden')
      } finally {
        await app.close()
      }
    })
  })
})

describe('http entities', () => {
  it('CRUDs content, gates writes to the owner, and reports errors', async () => {
    await withTestDatabase(async (pool) => {
      const { app, dm, player, worldId } = await setup(pool)
      const base = `/api/worlds/${worldId}/entities/npc`
      try {
        // create
        const created = await app.inject({
          method: 'POST',
          url: base,
          headers: { cookie: dm },
          payload: { name: 'Mira' },
        })
        expect(created.statusCode).toBe(201)
        const id = created.json().entity.id as string
        // list + get
        expect(
          (await app.inject({ method: 'GET', url: base, headers: { cookie: dm } })).json().entities,
        ).toHaveLength(1)
        expect(
          (
            await app.inject({ method: 'GET', url: `${base}/${id}`, headers: { cookie: dm } })
          ).json().entity.name,
        ).toBe('Mira')
        // patch + delete
        expect(
          (
            await app.inject({
              method: 'PATCH',
              url: `${base}/${id}`,
              headers: { cookie: dm },
              payload: { name: 'Mira II' },
            })
          ).json().entity.name,
        ).toBe('Mira II')
        expect(
          (await app.inject({ method: 'DELETE', url: `${base}/${id}`, headers: { cookie: dm } }))
            .statusCode,
        ).toBe(200)
        // missing → 404; unknown kind → 404
        expect(
          (await app.inject({ method: 'GET', url: `${base}/${id}`, headers: { cookie: dm } }))
            .statusCode,
        ).toBe(404)
        expect(
          (
            await app.inject({
              method: 'GET',
              url: `/api/worlds/${worldId}/entities/bogus`,
              headers: { cookie: dm },
            })
          ).statusCode,
        ).toBe(404)
        // validation: create without a name → 400
        expect(
          (await app.inject({ method: 'POST', url: base, headers: { cookie: dm }, payload: {} }))
            .statusCode,
        ).toBe(400)
        // a player cannot create content → 403
        expect(
          (
            await app.inject({
              method: 'POST',
              url: base,
              headers: { cookie: player },
              payload: { name: 'x' },
            })
          ).statusCode,
        ).toBe(403)
        // unknown columns are ignored by the content seam (only base + detail
        // columns are written), so a stray field still creates the entity
        const okStray = await app.inject({
          method: 'POST',
          url: base,
          headers: { cookie: dm },
          payload: { name: 'stray-ok', not_a_column: 1 },
        })
        expect(okStray.statusCode).toBe(201)
        // a genuine DB error (an invalid visibility violates the CHECK) bubbles up
        // as a 500 with the internal envelope
        const boom = await app.inject({
          method: 'POST',
          url: base,
          headers: { cookie: dm },
          payload: { name: 'x', visibility: 'bogus' },
        })
        expect(boom.statusCode).toBe(500)
        expect(boom.json().error.code).toBe('internal')
      } finally {
        await app.close()
      }
    })
  })

  it('change-kind reclassifies an entity, owner-only, validating the target kind', async () => {
    await withTestDatabase(async (pool) => {
      const { app, dm, player, worldId } = await setup(pool)
      try {
        const npc = (
          await app.inject({
            method: 'POST',
            url: `/api/worlds/${worldId}/entities/npc`,
            headers: { cookie: dm },
            payload: { name: 'Mara', occupation: 'keeper' },
          })
        ).json().entity
        const ck = (id: string) => `/api/worlds/${worldId}/entities/npc/${id}/change-kind`

        // success: npc → pc, and it disappears from the npc kind
        const changed = await app.inject({
          method: 'POST',
          url: ck(npc.id),
          headers: { cookie: dm },
          payload: { toKind: 'pc' },
        })
        expect(changed.statusCode).toBe(200)
        expect(changed.json().entity.kind).toBe('pc')
        expect(
          (
            await app.inject({
              method: 'GET',
              url: `/api/worlds/${worldId}/entities/npc/${npc.id}`,
              headers: { cookie: dm },
            })
          ).statusCode,
        ).toBe(404)

        // invalid target kind → 400 invalid_kind_change
        const bad = await app.inject({
          method: 'POST',
          url: `/api/worlds/${worldId}/entities/pc/${npc.id}/change-kind`,
          headers: { cookie: dm },
          payload: { toKind: 'banana' },
        })
        expect(bad.statusCode).toBe(400)
        expect(bad.json().error.code).toBe('invalid_kind_change')

        // missing entity → 404
        expect(
          (
            await app.inject({
              method: 'POST',
              url: `/api/worlds/${worldId}/entities/pc/nope/change-kind`,
              headers: { cookie: dm },
              payload: { toKind: 'npc' },
            })
          ).statusCode,
        ).toBe(404)

        // a player cannot reclassify → 403
        expect(
          (
            await app.inject({
              method: 'POST',
              url: `/api/worlds/${worldId}/entities/pc/${npc.id}/change-kind`,
              headers: { cookie: player },
              payload: { toKind: 'npc' },
            })
          ).statusCode,
        ).toBe(403)
      } finally {
        await app.close()
      }
    })
  })

  it('serves the wiki index across kinds (incl. sessions) for every member', async () => {
    await withTestDatabase(async (pool) => {
      const { app, dm, player, worldId } = await setup(pool)
      const w = `/api/worlds/${worldId}`
      try {
        await app.inject({
          method: 'POST',
          url: `${w}/entities/npc`,
          headers: { cookie: dm },
          payload: { name: 'Mira' },
        })
        await app.inject({
          method: 'POST',
          url: `${w}/entities/session`,
          headers: { cookie: dm },
          payload: { name: 'Session 1' },
        })
        // a member sees both the npc and the session in one aggregate
        const res = await app.inject({
          method: 'GET',
          url: `${w}/wiki`,
          headers: { cookie: player },
        })
        expect(res.statusCode).toBe(200)
        const entries = res.json().entries as Array<{ kind: string; name: string }>
        expect(entries).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ kind: 'npc', name: 'Mira' }),
            expect.objectContaining({ kind: 'session', name: 'Session 1' }),
          ]),
        )
      } finally {
        await app.close()
      }
    })
  })

  it('serves the entity graph', async () => {
    await withTestDatabase(async (pool) => {
      const { app, dm, worldId } = await setup(pool)
      try {
        await app.inject({
          method: 'POST',
          url: `/api/worlds/${worldId}/entities/npc`,
          headers: { cookie: dm },
          payload: { name: 'Mira' },
        })
        const g = await app.inject({
          method: 'GET',
          url: `/api/worlds/${worldId}/graph`,
          headers: { cookie: dm },
        })
        expect(g.statusCode).toBe(200)
        expect(g.json().graph.nodes.length).toBeGreaterThan(0)
      } finally {
        await app.close()
      }
    })
  })
})

describe('http sessions', () => {
  it('CRUDs sessions, lets all members read, gates writes to the owner, and is not suggestable', async () => {
    await withTestDatabase(async (pool) => {
      const { app, dm, player, worldId } = await setup(pool)
      const base = `/api/worlds/${worldId}/entities/session`
      try {
        // empty world → empty session list (the web renders an empty-state here)
        expect(
          (await app.inject({ method: 'GET', url: base, headers: { cookie: dm } })).json().entities,
        ).toHaveLength(0)

        // owner creates a session (no more "unknown entity kind: session")
        const created = await app.inject({
          method: 'POST',
          url: base,
          headers: { cookie: dm },
          payload: { name: 'Session 1' },
        })
        expect(created.statusCode).toBe(201)
        const id = created.json().entity.id as string

        // owner edits the session-specific fields (summary + played-at)
        const patched = await app.inject({
          method: 'PATCH',
          url: `${base}/${id}`,
          headers: { cookie: dm },
          payload: { played_at: '2026-06-27', captured_text: 'The party met Mira.' },
        })
        expect(patched.statusCode).toBe(200)
        expect(patched.json().entity.played_at).toBe('2026-06-27')
        expect(patched.json().entity.captured_text).toBe('The party met Mira.')

        // every member reads it (sessions carry no secrecy in this surface)
        expect(
          (await app.inject({ method: 'GET', url: base, headers: { cookie: player } })).json()
            .entities,
        ).toHaveLength(1)
        expect(
          (
            await app.inject({ method: 'GET', url: `${base}/${id}`, headers: { cookie: player } })
          ).json().entity.name,
        ).toBe('Session 1')

        // a player cannot create, update, or delete a session → 403
        for (const call of [
          { method: 'POST' as const, url: base, payload: { name: 'nope' } },
          { method: 'PATCH' as const, url: `${base}/${id}`, payload: { name: 'nope' } },
          { method: 'DELETE' as const, url: `${base}/${id}` },
        ]) {
          expect((await app.inject({ ...call, headers: { cookie: player } })).statusCode).toBe(403)
        }

        // sessions are NOT a suggestion target (kept out of CONTENT_REPOS)
        const sug = await app.inject({
          method: 'POST',
          url: `/api/worlds/${worldId}/suggestions`,
          headers: { cookie: player },
          payload: { targetKind: 'session', targetId: id, proposed: { name: 'x' } },
        })
        expect(sug.statusCode).toBe(403)
        expect(sug.json().error.message).toContain('not a suggestable entity kind')

        // owner soft-deletes
        expect(
          (await app.inject({ method: 'DELETE', url: `${base}/${id}`, headers: { cookie: dm } }))
            .statusCode,
        ).toBe(200)
        expect(
          (await app.inject({ method: 'GET', url: base, headers: { cookie: dm } })).json().entities,
        ).toHaveLength(0)
      } finally {
        await app.close()
      }
    })
  })
})

describe('http session touches, graph edges, and entity history', () => {
  it('records touches (owner-only), feeds the graph + entity history, validates, and 404s', async () => {
    await withTestDatabase(async (pool) => {
      const { app, dm, player, worldId } = await setup(pool)
      const w = `/api/worlds/${worldId}`
      const h = (c: string): { cookie: string } => ({ cookie: c })
      type Edge = { type: string; from: { id: string }; to: { kind: string; id: string } }
      type Node = { kind: string; id: string }
      try {
        // seed an npc + a session whose captured_text brackets it
        const npc = (
          await app.inject({
            method: 'POST',
            url: `${w}/entities/npc`,
            headers: h(dm),
            payload: { name: 'Mira' },
          })
        ).json().entity as { id: string }
        const session = (
          await app.inject({
            method: 'POST',
            url: `${w}/entities/session`,
            headers: h(dm),
            payload: { name: 'Session 1' },
          })
        ).json().entity as { id: string }
        await app.inject({
          method: 'PATCH',
          url: `${w}/entities/session/${session.id}`,
          headers: h(dm),
          payload: { captured_text: 'the party met [[Mira]]' },
        })

        // owner records a touch
        const created = await app.inject({
          method: 'POST',
          url: `${w}/sessions/${session.id}/touches`,
          headers: h(dm),
          payload: {
            entityKind: 'npc',
            entityId: npc.id,
            touchType: 'met',
            narrativeDelta: 'at the docks',
          },
        })
        expect(created.statusCode).toBe(201)
        const touchId = created.json().touch.id as string

        // every member reads touches; a player cannot write
        expect(
          (
            await app.inject({
              method: 'GET',
              url: `${w}/sessions/${session.id}/touches`,
              headers: h(player),
            })
          ).json().touches,
        ).toHaveLength(1)
        expect(
          (
            await app.inject({
              method: 'POST',
              url: `${w}/sessions/${session.id}/touches`,
              headers: h(player),
              payload: {
                entityKind: 'npc',
                entityId: npc.id,
                touchType: 'met',
                narrativeDelta: 'at the docks',
              },
            })
          ).statusCode,
        ).toBe(403)
        expect(
          (
            await app.inject({
              method: 'DELETE',
              url: `${w}/sessions/${session.id}/touches/${touchId}`,
              headers: h(player),
            })
          ).statusCode,
        ).toBe(403)

        // an invalid touch type → 400
        expect(
          (
            await app.inject({
              method: 'POST',
              url: `${w}/sessions/${session.id}/touches`,
              headers: h(dm),
              payload: { entityKind: 'npc', entityId: npc.id, touchType: 'hugged' },
            })
          ).statusCode,
        ).toBe(400)

        // graph: a session node + a touch edge (npc→session); the bracket is
        // suppressed because the touch wins for the same pair.
        const graph = (
          await app.inject({ method: 'GET', url: `${w}/graph`, headers: h(dm) })
        ).json().graph as {
          nodes: Node[]
          edges: Edge[]
        }
        expect(graph.nodes.some((n) => n.kind === 'session' && n.id === session.id)).toBe(true)
        expect(
          graph.edges.some(
            (e) => e.type === 'touch' && e.from.id === npc.id && e.to.id === session.id,
          ),
        ).toBe(true)
        expect(graph.edges.some((e) => e.type === 'bracket')).toBe(false)

        // per-entity history: the npc appears in the session via the touch
        const hist = (
          await app.inject({
            method: 'GET',
            url: `${w}/entities/npc/${npc.id}/sessions`,
            headers: h(player),
          })
        ).json().sessions as Array<{ id: string; link: string }>
        expect(hist).toEqual([expect.objectContaining({ id: session.id, link: 'touch' })])

        // remove the touch → the bracket edge now surfaces (no touch to win)
        expect(
          (
            await app.inject({
              method: 'DELETE',
              url: `${w}/sessions/${session.id}/touches/${touchId}`,
              headers: h(dm),
            })
          ).statusCode,
        ).toBe(200)
        const graph2 = (
          await app.inject({ method: 'GET', url: `${w}/graph`, headers: h(dm) })
        ).json().graph as {
          edges: Edge[]
        }
        expect(
          graph2.edges.some(
            (e) => e.type === 'bracket' && e.from.id === npc.id && e.to.id === session.id,
          ),
        ).toBe(true)
        expect(graph2.edges.some((e) => e.type === 'touch')).toBe(false)

        // deleting a missing touch → 404
        expect(
          (
            await app.inject({
              method: 'DELETE',
              url: `${w}/sessions/${session.id}/touches/nope`,
              headers: h(dm),
            })
          ).statusCode,
        ).toBe(404)
      } finally {
        await app.close()
      }
    })
  })
})

describe('http touches: narrative default, bracket history, and the entity filter', () => {
  it('defaults narrative_delta, records bracket-only history, and filters by entity', async () => {
    await withTestDatabase(async (pool) => {
      const { app, dm, worldId } = await setup(pool)
      const w = `/api/worlds/${worldId}`
      const h = { cookie: dm }
      const create = async (kind: string, name: string): Promise<string> =>
        (
          await app.inject({
            method: 'POST',
            url: `${w}/entities/${kind}`,
            headers: h,
            payload: { name },
          })
        ).json().entity.id as string
      type S = Array<{ id: string; link: string }>
      try {
        const npcId = await create('npc', 'Mira')
        const settlementId = await create('settlement', 'Ashen')
        const sessionId = await create('session', 'Session 1')
        await app.inject({
          method: 'PATCH',
          url: `${w}/entities/session/${sessionId}`,
          headers: h,
          payload: { captured_text: 'met [[Mira]] near [[Ashen]]' },
        })

        // a touch WITHOUT narrativeDelta → server defaults it to ''
        const t1 = await app.inject({
          method: 'POST',
          url: `${w}/sessions/${sessionId}/touches`,
          headers: h,
          payload: { entityKind: 'npc', entityId: npcId, touchType: 'met' },
        })
        expect(t1.statusCode).toBe(201)
        expect(t1.json().touch.narrative_delta).toBe('')

        // npc history is via its touch; settlement history is via its bracket —
        // and each query filters out the other entity's link.
        const npcHist = (
          await app.inject({
            method: 'GET',
            url: `${w}/entities/npc/${npcId}/sessions`,
            headers: h,
          })
        ).json().sessions as S
        expect(npcHist).toEqual([expect.objectContaining({ id: sessionId, link: 'touch' })])
        const setHist = (
          await app.inject({
            method: 'GET',
            url: `${w}/entities/settlement/${settlementId}/sessions`,
            headers: h,
          })
        ).json().sessions as S
        expect(setHist).toEqual([expect.objectContaining({ id: sessionId, link: 'bracket' })])

        // an entity with no link → empty history
        const itemId = await create('item', 'Sword')
        expect(
          (
            await app.inject({
              method: 'GET',
              url: `${w}/entities/item/${itemId}/sessions`,
              headers: h,
            })
          ).json().sessions,
        ).toHaveLength(0)
      } finally {
        await app.close()
      }
    })
  })
})

describe('http player-data + suggestions', () => {
  it('round-trips notes, characters, and the suggestion queue', async () => {
    await withTestDatabase(async (pool) => {
      const { app, dm, player, worldId } = await setup(pool)
      const w = `/api/worlds/${worldId}`
      try {
        // notes (player owns)
        const note = await app.inject({
          method: 'POST',
          url: `${w}/notes`,
          headers: { cookie: player },
          payload: { body: 'mine' },
        })
        expect(note.statusCode).toBe(201)
        const noteId = note.json().note.id
        expect(
          (
            await app.inject({ method: 'GET', url: `${w}/notes`, headers: { cookie: player } })
          ).json().notes,
        ).toHaveLength(1)
        expect(
          (
            await app.inject({
              method: 'PATCH',
              url: `${w}/notes/${noteId}`,
              headers: { cookie: player },
              payload: { body: 'edit' },
            })
          ).statusCode,
        ).toBe(200)
        expect(
          (
            await app.inject({
              method: 'DELETE',
              url: `${w}/notes/${noteId}`,
              headers: { cookie: player },
            })
          ).statusCode,
        ).toBe(200)

        // characters
        const ch = await app.inject({
          method: 'POST',
          url: `${w}/characters`,
          headers: { cookie: player },
          payload: { name: 'Roland', data: { hp: 10 } },
        })
        expect(ch.statusCode).toBe(201)
        const chId = ch.json().character.id
        expect(
          (
            await app.inject({ method: 'GET', url: `${w}/characters`, headers: { cookie: player } })
          ).json().characters,
        ).toHaveLength(1)
        expect(
          (
            await app.inject({
              method: 'PATCH',
              url: `${w}/characters/${chId}`,
              headers: { cookie: player },
              payload: { name: 'Roland II' },
            })
          ).json().character.name,
        ).toBe('Roland II')
        expect(
          (
            await app.inject({
              method: 'DELETE',
              url: `${w}/characters/${chId}`,
              headers: { cookie: player },
            })
          ).statusCode,
        ).toBe(200)

        // suggestions: DM seeds an entity, player proposes, DM accepts
        const npc = await app.inject({
          method: 'POST',
          url: `${w}/entities/npc`,
          headers: { cookie: dm },
          payload: { name: 'Mira' },
        })
        const npcId = npc.json().entity.id
        const sug = await app.inject({
          method: 'POST',
          url: `${w}/suggestions`,
          headers: { cookie: player },
          payload: { targetKind: 'npc', targetId: npcId, proposed: { description: 'a fixer' } },
        })
        expect(sug.statusCode).toBe(201)
        const sugId = sug.json().suggestion.id
        expect(
          (
            await app.inject({ method: 'GET', url: `${w}/suggestions`, headers: { cookie: dm } })
          ).json().suggestions,
        ).toHaveLength(1)
        expect(
          (
            await app.inject({
              method: 'POST',
              url: `${w}/suggestions/${sugId}/accept`,
              headers: { cookie: dm },
            })
          ).statusCode,
        ).toBe(200)
        // a second accept is a 404 (already resolved); reject of nothing too
        expect(
          (
            await app.inject({
              method: 'POST',
              url: `${w}/suggestions/${sugId}/accept`,
              headers: { cookie: dm },
            })
          ).statusCode,
        ).toBe(404)
        expect(
          (
            await app.inject({
              method: 'POST',
              url: `${w}/suggestions/${sugId}/reject`,
              headers: { cookie: dm },
            })
          ).statusCode,
        ).toBe(404)
      } finally {
        await app.close()
      }
    })
  })
})

describe('http import/export', () => {
  it('exports for the owner only and imports a payload into a new world', async () => {
    await withTestDatabase(async (pool) => {
      const { app, dm, player, worldId } = await setup(pool)
      try {
        await app.inject({
          method: 'POST',
          url: `/api/worlds/${worldId}/entities/npc`,
          headers: { cookie: dm },
          payload: { name: 'Mira' },
        })
        // player cannot export
        expect(
          (
            await app.inject({
              method: 'GET',
              url: `/api/worlds/${worldId}/export`,
              headers: { cookie: player },
            })
          ).statusCode,
        ).toBe(403)
        // owner can
        const exp = await app.inject({
          method: 'GET',
          url: `/api/worlds/${worldId}/export`,
          headers: { cookie: dm },
        })
        expect(exp.statusCode).toBe(200)
        expect(exp.json().version).toBe(1)

        // import a small payload (fresh ids) into a brand-new world. Post-0005 the
        // wire keys by the `entities` base table (with a `kind`) + detail tables.
        const importData = {
          version: 1,
          tables: {
            entities: [
              { id: 'imp-sp1', name: 'ImpSpecies', kind: 'species' },
              { id: 'imp-npc1', name: 'ImpNpc', kind: 'npc' },
            ],
            npc_details: [{ entity_id: 'imp-npc1', occupation: 'smith' }],
          },
        }
        const imp = await app.inject({
          method: 'POST',
          url: '/api/worlds/import',
          headers: { cookie: dm },
          payload: { name: 'Imported', data: importData },
        })
        expect(imp.statusCode).toBe(201)
        expect(imp.json().counts.entities).toBe(2)
        expect(imp.json().counts.npc_details).toBe(1)
      } finally {
        await app.close()
      }
    })
  })
})

describe('http edge + error branches', () => {
  it('covers revoke, delete, not-found, and session edge paths', async () => {
    await withTestDatabase(async (pool) => {
      const { app, dm, playerId, worldId } = await setup(pool)
      const w = `/api/worlds/${worldId}`
      const h = { cookie: dm }
      try {
        // member revoke
        expect(
          (await app.inject({ method: 'DELETE', url: `${w}/members/${playerId}`, headers: h }))
            .statusCode,
        ).toBe(200)
        // not-found branches on every resource (each with a payload valid for its route)
        const missing: Array<[string, Record<string, unknown>]> = [
          [`${w}/entities/npc/nope`, { description: 'x' }],
          [`${w}/notes/nope`, { body: 'x' }],
          [`${w}/characters/nope`, { name: 'x' }],
        ]
        for (const [url, payload] of missing) {
          expect((await app.inject({ method: 'PATCH', url, headers: h, payload })).statusCode).toBe(
            404,
          )
          expect((await app.inject({ method: 'DELETE', url, headers: h })).statusCode).toBe(404)
        }
        expect(
          (await app.inject({ method: 'GET', url: `${w}/entities/npc/nope`, headers: h }))
            .statusCode,
        ).toBe(404)
        // session edges: logout without a cookie, and a tampered cookie
        expect((await app.inject({ method: 'POST', url: '/api/logout' })).statusCode).toBe(200)
        expect(
          (
            await app.inject({
              method: 'GET',
              url: '/api/me',
              headers: { cookie: 'cs_session=garbage' },
            })
          ).statusCode,
        ).toBe(401)
        // world delete (owner)
        expect((await app.inject({ method: 'DELETE', url: w, headers: h })).statusCode).toBe(200)
        // after deletion the owner is no longer a member → 403
        expect((await app.inject({ method: 'GET', url: w, headers: h })).statusCode).toBe(403)
      } finally {
        await app.close()
      }
    })
  })
})

describe('http per-player visibility grants', () => {
  it('owner grants/revokes a restricted entity; only granted players read it; players cannot manage grants', async () => {
    await withTestDatabase(async (pool) => {
      const { app, dm, player, playerId, worldId } = await setup(pool)
      try {
        const base = `/api/worlds/${worldId}`
        const created = await app.inject({
          method: 'POST',
          url: `${base}/entities/npc`,
          headers: { cookie: dm },
          payload: { name: 'Hidden', visibility: 'restricted' },
        })
        expect(created.statusCode).toBe(201)
        const id = created.json().entity.id as string

        const getAsPlayer = () =>
          app.inject({
            method: 'GET',
            url: `${base}/entities/npc/${id}`,
            headers: { cookie: player },
          })

        // ungranted player: hidden
        expect((await getAsPlayer()).statusCode).toBe(404)

        // a player cannot grant (owner-only)
        const playerGrant = await app.inject({
          method: 'POST',
          url: `${base}/entities/npc/${id}/grants`,
          headers: { cookie: player },
          payload: { accountId: playerId },
        })
        expect(playerGrant.statusCode).toBe(403)

        // owner grants the player
        const grant = await app.inject({
          method: 'POST',
          url: `${base}/entities/npc/${id}/grants`,
          headers: { cookie: dm },
          payload: { accountId: playerId },
        })
        expect(grant.statusCode).toBe(204)

        // now visible to the player; the owner sees the grant listed
        expect((await getAsPlayer()).statusCode).toBe(200)
        const grants = await app.inject({
          method: 'GET',
          url: `${base}/entities/npc/${id}/grants`,
          headers: { cookie: dm },
        })
        expect(grants.json()).toEqual({ accountIds: [playerId] })

        // owner revokes → hidden again
        const revoke = await app.inject({
          method: 'DELETE',
          url: `${base}/entities/npc/${id}/grants/${playerId}`,
          headers: { cookie: dm },
        })
        expect(revoke.statusCode).toBe(204)
        expect((await getAsPlayer()).statusCode).toBe(404)
      } finally {
        await app.close()
      }
    })
  })
})
