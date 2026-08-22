import type { FastifyInstance, LightMyRequestResponse } from 'fastify'
import type { Pool } from 'pg'
import { describe, expect, it } from 'vitest'
import type { EmailVerificationMail, Mailer } from '../auth/mailer'
import { createScryptAuth } from '../auth/service'
import { createDb } from '../db/kysely'
import { migrateToLatest } from '../db/migrator'
import { openFlags } from '../flags/config'
import { markEmailVerified, withTestDatabase } from '../db/test-database'
import { DEFAULT_LIMITS, type ResourceLimits } from '../tenancy/limits'
import { type AppDeps, buildApp } from './app'

const SECRET = 'test-secret-test-secret-test-secret'
const PW = 'pw-123456'

function fakeMailer(): { mailer: Mailer; verifications: EmailVerificationMail[] } {
  const verifications: EmailVerificationMail[] = []
  return {
    verifications,
    mailer: {
      sendPasswordReset(): Promise<void> {
        return Promise.resolve()
      },
      sendEmailVerification(mail: EmailVerificationMail): Promise<void> {
        verifications.push(mail)
        return Promise.resolve()
      },
    },
  }
}

async function setup(pool: Pool, extra: Partial<AppDeps> = {}) {
  const db = createDb(pool)
  await migrateToLatest(db)
  const auth = createScryptAuth(db)
  const { mailer, verifications } = fakeMailer()
  const app = buildApp({
    db,
    auth,
    cookieSecret: SECRET,
    cookieSecure: false,
    mailer,
    flags: openFlags(),
    ...extra,
  })
  await app.ready()
  return { app, db, auth, verifications }
}

async function register(
  app: FastifyInstance,
  username: string,
): Promise<{ cookie: string; id: string }> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/register',
    payload: { username, password: PW, email: `${username}@example.com` },
  })
  const c = res.cookies.find((x) => x.name === 'cs_session')
  if (!c) throw new Error(`no session cookie for ${username}`)
  return { cookie: `cs_session=${c.value}`, id: res.json().account.id as string }
}

const createWorld = (
  app: FastifyInstance,
  cookie: string,
  name: string,
): Promise<LightMyRequestResponse> =>
  app.inject({ method: 'POST', url: '/api/worlds', headers: { cookie }, payload: { name } })

describe('email verification — the gate', () => {
  it('mails a link on registration without being asked', async () => {
    await withTestDatabase(async (pool) => {
      const { app, verifications } = await setup(pool)

      await register(app, 'newbie')

      expect(verifications).toHaveLength(1)
      expect(verifications[0]?.to).toBe('newbie@example.com')
      expect(verifications[0]?.token).toBeTruthy()
    })
  })

  it('lets an unverified account sign in and browse — verification does NOT gate login', async () => {
    await withTestDatabase(async (pool) => {
      const { app } = await setup(pool)
      await register(app, 'newbie')

      const login = await app.inject({
        method: 'POST',
        url: '/api/login',
        payload: { username: 'newbie', password: PW },
      })
      expect(login.statusCode).toBe(200)

      const cookie = `cs_session=${login.cookies.find((c) => c.name === 'cs_session')?.value}`
      expect(
        (await app.inject({ method: 'GET', url: '/api/worlds', headers: { cookie } })).statusCode,
      ).toBe(200)
    })
  })

  it('blocks world creation until verified, then allows it', async () => {
    await withTestDatabase(async (pool) => {
      const { app, verifications } = await setup(pool)
      const { cookie } = await register(app, 'newbie')

      const blocked = await createWorld(app, cookie, 'W')
      expect(blocked.statusCode).toBe(403)
      expect(blocked.json().error.code).toBe('email_not_verified')
      expect(blocked.json().error.message).toMatch(/create a world/)

      const verified = await app.inject({
        method: 'POST',
        url: '/api/verify-email',
        payload: { token: verifications[0]?.token },
      })
      expect(verified.statusCode).toBe(200)

      expect((await createWorld(app, cookie, 'W')).statusCode).toBe(201)
    })
  })

  it('blocks inviting until verified', async () => {
    await withTestDatabase(async (pool) => {
      const { app, db, verifications } = await setup(pool)
      const { cookie, id } = await register(app, 'newbie')
      await markEmailVerified(db, id)
      const world = await createWorld(app, cookie, 'W')
      const worldId = world.json().world.slug as string

      // un-verify again to prove the invite gate is its own check
      await db
        .updateTable('accounts')
        .set({ email_verified_at: null })
        .where('id', '=', id)
        .execute()

      const res = await app.inject({
        method: 'POST',
        url: `/api/worlds/${worldId}/invitations`,
        headers: { cookie },
        payload: {},
      })
      expect(res.statusCode).toBe(403)
      expect(res.json().error.code).toBe('email_not_verified')
      expect(verifications).toHaveLength(1)
    })
  })

  /**
   * The load-bearing exemption: the live owner account was minted by the
   * operator CLI before emails existed. If verification gated it, deploying
   * this migration would lock the operator out of their own instance.
   */
  it('does not gate an account that has NO email — it has nothing to prove', async () => {
    await withTestDatabase(async (pool) => {
      const { app, auth } = await setup(pool)
      await auth.createAccount('operator', PW)
      const login = await app.inject({
        method: 'POST',
        url: '/api/login',
        payload: { username: 'operator', password: PW },
      })
      const cookie = `cs_session=${login.cookies.find((c) => c.name === 'cs_session')?.value}`

      expect((await createWorld(app, cookie, 'W')).statusCode).toBe(201)
    })
  })
})

describe('email verification — the token', () => {
  it('rejects an unknown, a reused, and an expired token identically', async () => {
    await withTestDatabase(async (pool) => {
      let now = new Date('2026-07-30T10:00:00Z')
      const { app, verifications } = await setup(pool, { now: () => now })
      await register(app, 'newbie')
      const token = verifications[0]?.token as string

      const verify = (t: string): Promise<LightMyRequestResponse> =>
        app.inject({ method: 'POST', url: '/api/verify-email', payload: { token: t } })

      const unknown = await verify('not-a-real-token')
      expect(unknown.statusCode).toBe(400)
      expect(unknown.json().error.code).toBe('invalid_or_expired_token')

      expect((await verify(token)).statusCode).toBe(200)
      const reused = await verify(token)
      expect(reused.statusCode).toBe(400)
      expect(reused.json().error.code).toBe('invalid_or_expired_token')

      // a fresh token, then let it lapse
      await register(app, 'later')
      const second = verifications[1]?.token as string
      now = new Date('2026-08-02T10:00:00Z')
      const expired = await verify(second)
      expect(expired.statusCode).toBe(400)
      expect(expired.json().error.code).toBe('invalid_or_expired_token')
    })
  })

  it('resends on request, and throttles a hammered resend', async () => {
    await withTestDatabase(async (pool) => {
      let now = new Date('2026-07-30T10:00:00Z')
      const { app, verifications } = await setup(pool, { now: () => now })
      const { cookie } = await register(app, 'newbie')
      expect(verifications).toHaveLength(1)

      const resend = (): Promise<LightMyRequestResponse> =>
        app.inject({
          method: 'POST',
          url: '/api/account/verification/resend',
          headers: { cookie },
        })

      // inside the throttle window: answered 200 but nothing sent
      expect((await resend()).statusCode).toBe(200)
      expect(verifications).toHaveLength(1)

      now = new Date('2026-07-30T10:05:00Z')
      expect((await resend()).statusCode).toBe(200)
      expect(verifications).toHaveLength(2)
      // and the newer token supersedes the older one
      expect(verifications[1]?.token).not.toBe(verifications[0]?.token)
    })
  })

  it('answers a resend for an account with no address without sending anything', async () => {
    await withTestDatabase(async (pool) => {
      const { app, auth, verifications } = await setup(pool)
      await auth.createAccount('operator', PW)
      const login = await app.inject({
        method: 'POST',
        url: '/api/login',
        payload: { username: 'operator', password: PW },
      })
      const cookie = `cs_session=${login.cookies.find((c) => c.name === 'cs_session')?.value}`

      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/account/verification/resend',
            headers: { cookie },
          })
        ).statusCode,
      ).toBe(200)
      expect(verifications).toHaveLength(0)
    })
  })

  it('reports verification state and the live limits so the UI can show them first', async () => {
    await withTestDatabase(async (pool) => {
      const limits: ResourceLimits = {
        ...DEFAULT_LIMITS,
        worldsPerAccount: 2,
        entitiesPerWorld: 3,
        mediaBytesPerWorld: 1024,
      }
      const { app, db, verifications } = await setup(pool, { limits })
      const { cookie, id } = await register(app, 'newbie')

      const before = await app.inject({
        method: 'GET',
        url: '/api/account/status',
        headers: { cookie },
      })
      expect(before.json()).toEqual({
        emailVerified: false,
        limits,
        usage: { worlds: 0 },
      })

      await markEmailVerified(db, id)
      await createWorld(app, cookie, 'W')
      const after = await app.inject({
        method: 'GET',
        url: '/api/account/status',
        headers: { cookie },
      })
      expect(after.json().emailVerified).toBe(true)
      expect(after.json().usage.worlds).toBe(1)
      expect(verifications).toHaveLength(1)
    })
  })
})

describe('resource limits', () => {
  const tight: ResourceLimits = {
    ...DEFAULT_LIMITS,
    worldsPerAccount: 2,
    entitiesPerWorld: 2,
    mediaBytesPerWorld: 1024,
  }

  it('caps worlds per account with an actionable refusal, not a 500', async () => {
    await withTestDatabase(async (pool) => {
      const { app, db } = await setup(pool, { limits: tight })
      const { cookie, id } = await register(app, 'newbie')
      await markEmailVerified(db, id)

      expect((await createWorld(app, cookie, 'one')).statusCode).toBe(201)
      expect((await createWorld(app, cookie, 'two')).statusCode).toBe(201)

      const third = await createWorld(app, cookie, 'three')
      expect(third.statusCode).toBe(409)
      expect(third.json().error.code).toBe('limit_reached')
      expect(third.json().error.message).toMatch(/maximum of 2 worlds/)
      expect(third.json().error.message).toMatch(/delete or transfer one/)
    })
  })

  it('frees the allowance again once a world is deleted', async () => {
    await withTestDatabase(async (pool) => {
      const { app, db } = await setup(pool, { limits: tight })
      const { cookie, id } = await register(app, 'newbie')
      await markEmailVerified(db, id)

      const first = await createWorld(app, cookie, 'one')
      await createWorld(app, cookie, 'two')
      expect((await createWorld(app, cookie, 'three')).statusCode).toBe(409)

      await app.inject({
        method: 'DELETE',
        url: `/api/worlds/${first.json().world.slug}`,
        headers: { cookie },
      })
      expect((await createWorld(app, cookie, 'three')).statusCode).toBe(201)
    })
  })

  it('caps entities per world', async () => {
    await withTestDatabase(async (pool) => {
      const { app, db } = await setup(pool, { limits: tight })
      const { cookie, id } = await register(app, 'newbie')
      await markEmailVerified(db, id)
      const world = await createWorld(app, cookie, 'W')
      const base = `/api/worlds/${world.json().world.slug}`

      const npc = (name: string): Promise<LightMyRequestResponse> =>
        app.inject({
          method: 'POST',
          url: `${base}/entities/npc`,
          headers: { cookie },
          payload: { name },
        })

      expect((await npc('a')).statusCode).toBe(201)
      expect((await npc('b')).statusCode).toBe(201)
      const third = await npc('c')
      expect(third.statusCode).toBe(409)
      expect(third.json().error.code).toBe('limit_reached')
      expect(third.json().error.message).toMatch(/maximum of 2 pages/)
    })
  })

  it('applies the environment defaults when the caller passes none', async () => {
    await withTestDatabase(async (pool) => {
      const { app } = await setup(pool)
      const { cookie } = await register(app, 'newbie')
      const status = await app.inject({
        method: 'GET',
        url: '/api/account/status',
        headers: { cookie },
      })
      // the shipped defaults, not zeroes or Infinity
      expect(status.json().limits.worldsPerAccount).toBe(5)
      expect(status.json().limits.entitiesPerWorld).toBe(2000)
    })
  })
})
