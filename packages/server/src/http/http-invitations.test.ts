import type { FastifyInstance, LightMyRequestResponse } from 'fastify'
import type { Pool } from 'pg'
import { describe, expect, it } from 'vitest'
import { createScryptAuth } from '../auth/service'
import { createDb } from '../db/kysely'
import { migrateToLatest } from '../db/migrator'
import { openFlags } from '../flags/config'
import { markEmailVerified, withTestDatabase } from '../db/test-database'
import { type AppDeps, buildApp } from './app'

const SECRET = 'test-secret-test-secret-test-secret'
const DAY_MS = 24 * 60 * 60 * 1000

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

/** A world owned by `dm`, with `player` a member and `friend` an unaffiliated account. */
async function setup(pool: Pool, extra: Partial<AppDeps> = {}) {
  const db = createDb(pool)
  await migrateToLatest(db)
  const auth = createScryptAuth(db)
  const app = buildApp({
    db,
    auth,
    cookieSecret: SECRET,
    cookieSecure: false,
    // This suite's subject is invitations, not the access gate — flags ship
    // fail-closed, and restating the policy in every setup is how setups drift
    // from the real defaults. The gate has its own suite.
    flags: openFlags(),
    ...extra,
  })
  await app.ready()

  // Verified up front: world creation is gated on it, and this suite's subject
  // is invitations, not the verification gate itself.
  const dmAccount = await auth.createAccount('dm', 'pw-123456', 'dm@example.com')
  await markEmailVerified(db, dmAccount.id)
  const player = await auth.createAccount('player', 'pw-123456', 'player@example.com')
  const friend = await auth.createAccount('friend', 'pw-123456', 'friend@example.com')

  const dm = await login(app, 'dm', 'pw-123456')
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
  return { app, auth, db, dm, worldId, friend, player }
}

const invite = (
  app: FastifyInstance,
  worldId: string,
  cookie: string,
  body: Record<string, unknown> = {},
): Promise<LightMyRequestResponse> =>
  app.inject({
    method: 'POST',
    url: `/api/worlds/${worldId}/invitations`,
    headers: { cookie },
    payload: body,
  })

const worldsOf = async (app: FastifyInstance, cookie: string): Promise<string[]> =>
  (
    (await app.inject({ method: 'GET', url: '/api/worlds', headers: { cookie } })).json() as {
      worlds: { slug: string }[]
    }
  ).worlds.map((w) => w.slug)

describe('invitations — owner side', () => {
  it('creates an open link, lists it as pending, and hands back the raw token exactly once', async () => {
    await withTestDatabase(async (pool) => {
      const { app, dm, worldId } = await setup(pool)

      const res = await invite(app, worldId, dm)
      expect(res.statusCode).toBe(201)
      const { id, token } = res.json() as { id: string; token: string }
      expect(token).toBeTruthy()

      const list = await app.inject({
        method: 'GET',
        url: `/api/worlds/${worldId}/invitations`,
        headers: { cookie: dm },
      })
      expect(list.statusCode).toBe(200)
      const [only] = (list.json() as { invitations: Record<string, unknown>[] }).invitations
      expect(only).toMatchObject({ id, status: 'pending', invitee: null, acceptedAt: null })
      // the raw token is NOT recoverable from the listing — only its hash was stored
      expect(list.body).not.toContain(token)
      await app.close()
    })
  })

  it('pins a named invitation to that account, and 404s an unknown name instead of widening it', async () => {
    await withTestDatabase(async (pool) => {
      const { app, dm, worldId } = await setup(pool)

      const named = await invite(app, worldId, dm, { username: 'friend' })
      expect(named.statusCode).toBe(201)

      const list = await app.inject({
        method: 'GET',
        url: `/api/worlds/${worldId}/invitations`,
        headers: { cookie: dm },
      })
      expect((list.json() as { invitations: { invitee: string }[] }).invitations[0]!.invitee).toBe(
        'friend',
      )

      // a typo must not silently become an invitation anyone can redeem
      const typo = await invite(app, worldId, dm, { username: 'freind' })
      expect(typo.statusCode).toBe(404)
      await app.close()
    })
  })

  it('refuses a member who is not the owner, and an outsider', async () => {
    await withTestDatabase(async (pool) => {
      const { app, worldId } = await setup(pool)
      const playerCookie = await login(app, 'player', 'pw-123456')
      const friendCookie = await login(app, 'friend', 'pw-123456')

      expect((await invite(app, worldId, playerCookie)).statusCode).toBe(403)
      expect((await invite(app, worldId, friendCookie)).statusCode).toBe(403)
      // and neither can read the invitation list
      expect(
        (
          await app.inject({
            method: 'GET',
            url: `/api/worlds/${worldId}/invitations`,
            headers: { cookie: playerCookie },
          })
        ).statusCode,
      ).toBe(403)
      await app.close()
    })
  })

  it('revokes a pending invitation and reports it as revoked', async () => {
    await withTestDatabase(async (pool) => {
      const { app, dm, worldId } = await setup(pool)
      const { id } = (await invite(app, worldId, dm)).json() as { id: string }

      const revoked = await app.inject({
        method: 'DELETE',
        url: `/api/worlds/${worldId}/invitations/${id}`,
        headers: { cookie: dm },
      })
      expect(revoked.statusCode).toBe(200)

      const list = await app.inject({
        method: 'GET',
        url: `/api/worlds/${worldId}/invitations`,
        headers: { cookie: dm },
      })
      expect((list.json() as { invitations: { status: string }[] }).invitations[0]!.status).toBe(
        'revoked',
      )

      // revoking twice is a 404, not a silent success
      expect(
        (
          await app.inject({
            method: 'DELETE',
            url: `/api/worlds/${worldId}/invitations/${id}`,
            headers: { cookie: dm },
          })
        ).statusCode,
      ).toBe(404)
      await app.close()
    })
  })

  it('reports a lapsed invitation as expired without anything having to sweep it', async () => {
    await withTestDatabase(async (pool) => {
      let clock = new Date('2026-01-01T00:00:00Z')
      const { app, dm, worldId } = await setup(pool, { now: () => clock })
      await invite(app, worldId, dm)

      clock = new Date(clock.getTime() + 8 * DAY_MS) // past the 7-day TTL
      const list = await app.inject({
        method: 'GET',
        url: `/api/worlds/${worldId}/invitations`,
        headers: { cookie: dm },
      })
      expect((list.json() as { invitations: { status: string }[] }).invitations[0]!.status).toBe(
        'expired',
      )
      await app.close()
    })
  })
})

describe('invitations — accepting as an existing user', () => {
  it('joins the world and marks the invitation accepted', async () => {
    await withTestDatabase(async (pool) => {
      const { app, dm, worldId } = await setup(pool)
      const { token } = (await invite(app, worldId, dm, { username: 'friend' })).json() as {
        token: string
      }
      const friendCookie = await login(app, 'friend', 'pw-123456')

      // before: the friend can see no worlds at all
      expect(await worldsOf(app, friendCookie)).toEqual([])

      const accepted = await app.inject({
        method: 'POST',
        url: `/api/invitations/${token}/accept`,
        headers: { cookie: friendCookie },
      })
      expect(accepted.statusCode).toBe(200)
      expect(accepted.json()).toEqual({ world: { worldName: 'W', worldSlug: worldId } })
      expect(await worldsOf(app, friendCookie)).toEqual([worldId])

      const list = await app.inject({
        method: 'GET',
        url: `/api/worlds/${worldId}/invitations`,
        headers: { cookie: dm },
      })
      expect(
        (list.json() as { invitations: { status: string; acceptedAt: string }[] }).invitations[0],
      ).toMatchObject({ status: 'accepted' })
      await app.close()
    })
  })

  it('joins as a PLAYER — an invitation cannot confer ownership', async () => {
    await withTestDatabase(async (pool) => {
      const { app, dm, worldId } = await setup(pool)
      const { token } = (await invite(app, worldId, dm)).json() as { token: string }
      const friendCookie = await login(app, 'friend', 'pw-123456')
      await app.inject({
        method: 'POST',
        url: `/api/invitations/${token}/accept`,
        headers: { cookie: friendCookie },
      })

      const worlds = (
        (
          await app.inject({ method: 'GET', url: '/api/worlds', headers: { cookie: friendCookie } })
        ).json() as { worlds: { role: string }[] }
      ).worlds
      expect(worlds[0]!.role).toBe('player')
      // and the new member cannot turn around and invite others
      expect((await invite(app, worldId, friendCookie)).statusCode).toBe(403)
      await app.close()
    })
  })

  it('refuses a token aimed at somebody else, identically to an invalid one', async () => {
    await withTestDatabase(async (pool) => {
      const { app, dm, worldId } = await setup(pool)
      const { token } = (await invite(app, worldId, dm, { username: 'friend' })).json() as {
        token: string
      }
      const playerCookie = await login(app, 'player', 'pw-123456')

      const wrongPerson = await app.inject({
        method: 'POST',
        url: `/api/invitations/${token}/accept`,
        headers: { cookie: playerCookie },
      })
      const nonsense = await app.inject({
        method: 'POST',
        url: '/api/invitations/not-a-real-token/accept',
        headers: { cookie: playerCookie },
      })
      expect(wrongPerson.statusCode).toBe(400)
      expect(wrongPerson.json()).toEqual(nonsense.json())
      expect(wrongPerson.json().error.code).toBe('invalid_invitation')

      // and the invitation survives for the person it was actually for
      const friendCookie = await login(app, 'friend', 'pw-123456')
      expect(
        (
          await app.inject({
            method: 'POST',
            url: `/api/invitations/${token}/accept`,
            headers: { cookie: friendCookie },
          })
        ).statusCode,
      ).toBe(200)
      await app.close()
    })
  })

  it('rejects a reused, a revoked, and an expired token', async () => {
    await withTestDatabase(async (pool) => {
      let clock = new Date('2026-01-01T00:00:00Z')
      const { app, dm, worldId } = await setup(pool, { now: () => clock })
      const friendCookie = await login(app, 'friend', 'pw-123456')
      const playerCookie = await login(app, 'player', 'pw-123456')

      // reused
      const { token: used } = (await invite(app, worldId, dm)).json() as { token: string }
      const accept = (cookie: string): Promise<LightMyRequestResponse> =>
        app.inject({ method: 'POST', url: `/api/invitations/${used}/accept`, headers: { cookie } })
      expect((await accept(friendCookie)).statusCode).toBe(200)
      const second = await accept(playerCookie)
      expect(second.statusCode).toBe(400)
      expect(second.json().error.code).toBe('invalid_invitation')

      // revoked
      const revokedInvite = (await invite(app, worldId, dm)).json() as {
        id: string
        token: string
      }
      await app.inject({
        method: 'DELETE',
        url: `/api/worlds/${worldId}/invitations/${revokedInvite.id}`,
        headers: { cookie: dm },
      })
      expect(
        (
          await app.inject({
            method: 'POST',
            url: `/api/invitations/${revokedInvite.token}/accept`,
            headers: { cookie: playerCookie },
          })
        ).statusCode,
      ).toBe(400)

      // expired
      const { token: stale } = (await invite(app, worldId, dm)).json() as { token: string }
      clock = new Date(clock.getTime() + 8 * DAY_MS)
      expect(
        (
          await app.inject({
            method: 'POST',
            url: `/api/invitations/${stale}/accept`,
            headers: { cookie: playerCookie },
          })
        ).statusCode,
      ).toBe(400)
      await app.close()
    })
  })

  it('requires a session to accept', async () => {
    await withTestDatabase(async (pool) => {
      const { app, dm, worldId } = await setup(pool)
      const { token } = (await invite(app, worldId, dm)).json() as { token: string }
      expect(
        (await app.inject({ method: 'POST', url: `/api/invitations/${token}/accept` })).statusCode,
      ).toBe(401)
      await app.close()
    })
  })
})

describe('invitations — previewing a token', () => {
  it('names the world for a live token so the invitee knows what they are joining', async () => {
    await withTestDatabase(async (pool) => {
      const { app, dm, worldId } = await setup(pool)
      const { token } = (await invite(app, worldId, dm, { username: 'friend' })).json() as {
        token: string
      }

      const res = await app.inject({ method: 'GET', url: `/api/invitations/${token}` })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ world: { name: 'W', slug: worldId }, targeted: true })
      // the preview must not name WHO it is for
      expect(res.body).not.toContain('friend')
      await app.close()
    })
  })

  it('tells a dead token nothing about the world it pointed at', async () => {
    await withTestDatabase(async (pool) => {
      let clock = new Date('2026-01-01T00:00:00Z')
      const { app, dm, worldId } = await setup(pool, { now: () => clock })
      const { token } = (await invite(app, worldId, dm)).json() as { token: string }
      clock = new Date(clock.getTime() + 8 * DAY_MS)

      const expired = await app.inject({ method: 'GET', url: `/api/invitations/${token}` })
      const unknown = await app.inject({ method: 'GET', url: '/api/invitations/never-existed' })
      expect(expired.statusCode).toBe(400)
      expect(expired.json()).toEqual(unknown.json())
      expect(expired.body).not.toContain(worldId)
      expect(expired.body).not.toContain('"W"')
      await app.close()
    })
  })
})

describe('invitations — accepting as a brand-new user', () => {
  const NEWCOMER = {
    username: 'newcomer',
    password: 'pw-123456',
    email: 'newcomer@example.com',
  }

  it('registers and joins in one step, even with public signup switched off', async () => {
    await withTestDatabase(async (pool) => {
      // Signup CLOSED, everything else open: the point is that the invitation
      // alone opens the door.
      const { app, dm, worldId } = await setup(pool, {
        flags: { ...openFlags(), publicSignupEnabled: false },
      })
      const { token } = (await invite(app, worldId, dm)).json() as { token: string }

      // the same request without a token is refused — the invitation is what opens the door
      expect(
        (await app.inject({ method: 'POST', url: '/api/register', payload: NEWCOMER })).statusCode,
      ).toBe(403)

      const res = await app.inject({
        method: 'POST',
        url: '/api/register',
        payload: { ...NEWCOMER, inviteToken: token },
      })
      expect(res.statusCode).toBe(201)

      // signed in, and already inside the world
      const cookie = `cs_session=${res.cookies.find((c) => c.name === 'cs_session')!.value}`
      expect(await worldsOf(app, cookie)).toEqual([worldId])
      await app.close()
    })
  })

  it('does not burn the invitation when registration itself fails', async () => {
    await withTestDatabase(async (pool) => {
      const { app, dm, worldId } = await setup(pool)
      const { token } = (await invite(app, worldId, dm)).json() as { token: string }

      // a name that is already taken — a typo must not cost the only way in
      const clash = await app.inject({
        method: 'POST',
        url: '/api/register',
        payload: { ...NEWCOMER, username: 'player', inviteToken: token },
      })
      expect(clash.statusCode).toBe(409)

      const retry = await app.inject({
        method: 'POST',
        url: '/api/register',
        payload: { ...NEWCOMER, inviteToken: token },
      })
      expect(retry.statusCode).toBe(201)
      const cookie = `cs_session=${retry.cookies.find((c) => c.name === 'cs_session')!.value}`
      expect(await worldsOf(app, cookie)).toEqual([worldId])
      await app.close()
    })
  })

  it('will not let a junk token prise open a closed instance', async () => {
    await withTestDatabase(async (pool) => {
      const { app } = await setup(pool, {
        flags: { ...openFlags(), publicSignupEnabled: false },
      })
      const res = await app.inject({
        method: 'POST',
        url: '/api/register',
        payload: { ...NEWCOMER, inviteToken: 'not-a-real-token' },
      })
      expect(res.statusCode).toBe(403)
      expect(res.json().error.code).toBe('signup_closed')
      await app.close()
    })
  })

  it('still registers without a token when public signup is open', async () => {
    await withTestDatabase(async (pool) => {
      const { app } = await setup(pool, { flags: openFlags() })
      expect(
        (await app.inject({ method: 'POST', url: '/api/register', payload: NEWCOMER })).statusCode,
      ).toBe(201)
      await app.close()
    })
  })
})
