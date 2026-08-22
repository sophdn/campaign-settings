import type { FastifyInstance } from 'fastify'
import type { Pool } from 'pg'
import { describe, expect, it } from 'vitest'
import { createScryptAuth } from '../auth/service'
import type { AuthService } from '../auth/types'
import { createDb } from '../db/kysely'
import { migrateToLatest } from '../db/migrator'
import { openFlags } from '../flags/config'
import { withTestDatabase } from '../db/test-database'
import { type AppDeps, buildApp } from './app'

const SECRET = 'test-secret-test-secret-test-secret'

const FIREFOX = 'Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0'
const IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'

/** Short enough that a test clock can step past it. */
const SESSION_TTL_MS = 600_000

async function setup(
  pool: Pool,
  extra: Partial<AppDeps> = {},
): Promise<{ app: FastifyInstance; auth: AuthService }> {
  const db = createDb(pool)
  await migrateToLatest(db)
  // The TTL and the clock belong to the auth service (it owns session rows);
  // buildApp's copy of the TTL only sizes the cookie's max-age.
  // The TTL goes HERE and only here — the service owns session rows, and since
  // bug 1205 the cookie's max-age is derived from it rather than passed
  // separately to buildApp.
  const auth = createScryptAuth(db, {
    sessionTtlMs: SESSION_TTL_MS,
    ...(extra.now ? { now: extra.now } : {}),
  })
  const app = buildApp({
    db,
    auth,
    cookieSecret: SECRET,
    cookieSecure: false,
    // This suite's subject is the account flows, not the access gate — flags
    // ship fail-closed, and restating the policy in every setup is how setups
    // drift from the real defaults. The gate has its own suite.
    flags: openFlags(),
    ...extra,
  })
  await app.ready()
  return { app, auth }
}

const cookieOf = (res: { cookies: { name: string; value: string }[] }): string => {
  const c = res.cookies.find((x) => x.name === 'cs_session')
  if (!c) throw new Error('no session cookie on response')
  return `cs_session=${c.value}`
}

/** Sign in and return the resulting cookie header. */
async function signIn(
  app: FastifyInstance,
  username: string,
  password: string,
  userAgent?: string,
): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/login',
    payload: { username, password },
    ...(userAgent ? { headers: { 'user-agent': userAgent } } : {}),
  })
  expect(res.statusCode).toBe(200)
  return cookieOf(res)
}

const authed = async (app: FastifyInstance, cookie: string): Promise<number> =>
  (await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } })).statusCode

describe('account: password change', () => {
  it('changes the password, ends other devices, and keeps the caller signed in on a fresh session id', async () => {
    await withTestDatabase(async (pool) => {
      const { app, auth } = await setup(pool)
      await auth.createAccount('dm', 'old-password-1')

      const here = await signIn(app, 'dm', 'old-password-1', FIREFOX)
      const elsewhere = await signIn(app, 'dm', 'old-password-1', IPHONE)

      const res = await app.inject({
        method: 'POST',
        url: '/api/account/password',
        headers: { cookie: here, 'user-agent': FIREFOX },
        payload: { currentPassword: 'old-password-1', newPassword: 'new-password-2' },
      })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ ok: true })

      // the caller is handed a NEW session id, and it works
      const rotated = cookieOf(res)
      expect(rotated).not.toBe(here)
      expect(await authed(app, rotated)).toBe(200)

      // the pre-change cookie is dead — a captured session does not survive the change
      expect(await authed(app, here)).toBe(401)
      // and so is every other device
      expect(await authed(app, elsewhere)).toBe(401)

      // credentials actually changed
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/login',
            payload: { username: 'dm', password: 'old-password-1' },
          })
        ).statusCode,
      ).toBe(401)
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/login',
            payload: { username: 'dm', password: 'new-password-2' },
          })
        ).statusCode,
      ).toBe(200)
      await app.close()
    })
  })

  it('rejects a wrong current password and leaves the account untouched', async () => {
    await withTestDatabase(async (pool) => {
      const { app, auth } = await setup(pool)
      await auth.createAccount('dm', 'old-password-1')
      const cookie = await signIn(app, 'dm', 'old-password-1')

      const res = await app.inject({
        method: 'POST',
        url: '/api/account/password',
        headers: { cookie },
        payload: { currentPassword: 'not-the-password', newPassword: 'new-password-2' },
      })
      expect(res.statusCode).toBe(401)
      expect(res.json()).toEqual({
        error: { code: 'invalid_credentials', message: expect.any(String) },
      })

      // still signed in, still on the old password
      expect(await authed(app, cookie)).toBe(200)
      expect(
        await auth.verifyAccountPassword(
          (await auth.login('dm', 'old-password-1'))!.account.id,
          'old-password-1',
        ),
      ).toBe(true)
      await app.close()
    })
  })

  it('rejects a new password under the shared minimum length', async () => {
    await withTestDatabase(async (pool) => {
      const { app, auth } = await setup(pool)
      await auth.createAccount('dm', 'old-password-1')
      const cookie = await signIn(app, 'dm', 'old-password-1')

      const res = await app.inject({
        method: 'POST',
        url: '/api/account/password',
        headers: { cookie },
        payload: { currentPassword: 'old-password-1', newPassword: 'short' },
      })
      expect(res.statusCode).toBe(400)
      expect(res.json().error.code).toBe('invalid_request')

      // the old password still works — nothing was written
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/login',
            payload: { username: 'dm', password: 'old-password-1' },
          })
        ).statusCode,
      ).toBe(200)
      await app.close()
    })
  })

  it('requires a session', async () => {
    await withTestDatabase(async (pool) => {
      const { app } = await setup(pool)
      const res = await app.inject({
        method: 'POST',
        url: '/api/account/password',
        payload: { currentPassword: 'old-password-1', newPassword: 'new-password-2' },
      })
      expect(res.statusCode).toBe(401)
      await app.close()
    })
  })
})

describe('account: username change', () => {
  it('renames the account and makes the new name the login key', async () => {
    await withTestDatabase(async (pool) => {
      const { app, auth } = await setup(pool)
      const account = await auth.createAccount('dm', 'pw-123456')
      const cookie = await signIn(app, 'dm', 'pw-123456')

      const res = await app.inject({
        method: 'POST',
        url: '/api/account/username',
        headers: { cookie },
        payload: { username: 'game-master' },
      })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ account: { id: account.id, username: 'game-master' } })

      // the rename does not sign anyone out — sessions key on the account, not the name
      expect(await authed(app, cookie)).toBe(200)
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/login',
            payload: { username: 'game-master', password: 'pw-123456' },
          })
        ).statusCode,
      ).toBe(200)
      await app.close()
    })
  })

  it('rejects a name already held by another account with the same 409 registration uses', async () => {
    await withTestDatabase(async (pool) => {
      const { app, auth } = await setup(pool)
      await auth.createAccount('dm', 'pw-123456')
      await auth.createAccount('player', 'pw-123456')
      const cookie = await signIn(app, 'dm', 'pw-123456')

      const res = await app.inject({
        method: 'POST',
        url: '/api/account/username',
        headers: { cookie },
        payload: { username: 'player' },
      })
      expect(res.statusCode).toBe(409)
      expect(res.json()).toEqual({
        error: { code: 'username_taken', message: expect.any(String) },
      })

      // the original name still logs in — the failed rename did not half-apply
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/login',
            payload: { username: 'dm', password: 'pw-123456' },
          })
        ).statusCode,
      ).toBe(200)
      await app.close()
    })
  })

  it('rejects a case variant of a name someone else holds', async () => {
    await withTestDatabase(async (pool) => {
      const { app, auth } = await setup(pool)
      await auth.createAccount('dm', 'pw-123456')
      await auth.createAccount('player', 'pw-123456')
      const cookie = await signIn(app, 'dm', 'pw-123456')

      const res = await app.inject({
        method: 'POST',
        url: '/api/account/username',
        headers: { cookie },
        payload: { username: 'PLAYER' },
      })
      expect(res.statusCode).toBe(409)
      expect(res.json().error.code).toBe('username_taken')
      await app.close()
    })
  })

  it('allows re-capitalising your own name', async () => {
    await withTestDatabase(async (pool) => {
      const { app, auth } = await setup(pool)
      const account = await auth.createAccount('dm', 'pw-123456')
      const cookie = await signIn(app, 'dm', 'pw-123456')

      const res = await app.inject({
        method: 'POST',
        url: '/api/account/username',
        headers: { cookie },
        payload: { username: 'DM' },
      })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ account: { id: account.id, username: 'DM' } })
      // and the old capitalisation still logs in — it is the same account
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/login',
            payload: { username: 'dm', password: 'pw-123456' },
          })
        ).statusCode,
      ).toBe(200)
      await app.close()
    })
  })

  it('rejects an empty username and requires a session', async () => {
    await withTestDatabase(async (pool) => {
      const { app, auth } = await setup(pool)
      await auth.createAccount('dm', 'pw-123456')
      const cookie = await signIn(app, 'dm', 'pw-123456')

      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/account/username',
            headers: { cookie },
            payload: { username: '' },
          })
        ).statusCode,
      ).toBe(400)
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/account/username',
            payload: { username: 'game-master' },
          })
        ).statusCode,
      ).toBe(401)
      await app.close()
    })
  })
})

describe('account: session list and revoke-all', () => {
  it('lists live sessions with a coarse device label, marks the current one, and never returns a session id', async () => {
    await withTestDatabase(async (pool) => {
      let clock = new Date('2026-01-01T00:00:00Z')
      const { app, auth } = await setup(pool, { now: () => clock })
      await auth.createAccount('dm', 'pw-123456')

      const laptop = await signIn(app, 'dm', 'pw-123456', FIREFOX)
      clock = new Date(clock.getTime() + 60_000)
      const phone = await signIn(app, 'dm', 'pw-123456', IPHONE)

      const res = await app.inject({
        method: 'GET',
        url: '/api/account/sessions',
        headers: { cookie: phone },
      })
      expect(res.statusCode).toBe(200)
      const { sessions } = res.json() as {
        sessions: { deviceLabel: string | null; current: boolean }[]
      }
      expect(sessions).toHaveLength(2)
      expect(sessions.map((s) => s.deviceLabel)).toEqual(['Safari on iOS', 'Firefox on Linux'])
      expect(sessions.map((s) => s.current)).toEqual([true, false])
      // the raw User-Agent is never stored, only the coarse label
      expect(res.body).not.toContain('AppleWebKit')
      // and the bearer credential never appears in the payload
      expect(res.body).not.toContain(laptop.replace('cs_session=', '').split('.')[0])
      await app.close()
    })
  })

  it('records no device label for a client that sends no User-Agent', async () => {
    await withTestDatabase(async (pool) => {
      const { app, auth } = await setup(pool)
      await auth.createAccount('dm', 'pw-123456')
      const cookie = await signIn(app, 'dm', 'pw-123456')

      const res = await app.inject({
        method: 'GET',
        url: '/api/account/sessions',
        headers: { cookie },
      })
      const { sessions } = res.json() as { sessions: { deviceLabel: string | null }[] }
      expect(sessions).toHaveLength(1)
      expect(sessions[0]!.deviceLabel).toBeNull()
      await app.close()
    })
  })

  it('revoke-all ends every other session and leaves the caller signed in', async () => {
    await withTestDatabase(async (pool) => {
      const { app, auth } = await setup(pool)
      await auth.createAccount('dm', 'pw-123456')

      const here = await signIn(app, 'dm', 'pw-123456', FIREFOX)
      const elsewhere = await signIn(app, 'dm', 'pw-123456', IPHONE)
      const alsoElsewhere = await signIn(app, 'dm', 'pw-123456', IPHONE)

      const res = await app.inject({
        method: 'POST',
        url: '/api/account/sessions/revoke-all',
        headers: { cookie: here },
      })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ ok: true })

      expect(await authed(app, here)).toBe(200)
      expect(await authed(app, elsewhere)).toBe(401)
      expect(await authed(app, alsoElsewhere)).toBe(401)

      const list = await app.inject({
        method: 'GET',
        url: '/api/account/sessions',
        headers: { cookie: here },
      })
      expect((list.json() as { sessions: unknown[] }).sessions).toHaveLength(1)
      await app.close()
    })
  })

  it('an expired session is rejected and drops out of the list', async () => {
    await withTestDatabase(async (pool) => {
      let clock = new Date('2026-01-01T00:00:00Z')
      const { app, auth } = await setup(pool, { now: () => clock })
      await auth.createAccount('dm', 'pw-123456')
      const stale = await signIn(app, 'dm', 'pw-123456', FIREFOX)

      clock = new Date(clock.getTime() + 600_001) // past the TTL
      expect(await authed(app, stale)).toBe(401)

      const fresh = await signIn(app, 'dm', 'pw-123456', IPHONE)
      const list = await app.inject({
        method: 'GET',
        url: '/api/account/sessions',
        headers: { cookie: fresh },
      })
      expect((list.json() as { sessions: unknown[] }).sessions).toHaveLength(1)
      await app.close()
    })
  })

  it('both session routes require a session', async () => {
    await withTestDatabase(async (pool) => {
      const { app } = await setup(pool)
      expect((await app.inject({ method: 'GET', url: '/api/account/sessions' })).statusCode).toBe(
        401,
      )
      expect(
        (await app.inject({ method: 'POST', url: '/api/account/sessions/revoke-all' })).statusCode,
      ).toBe(401)
      await app.close()
    })
  })
})
