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

/** Registration is off unless a test explicitly opens it — same as production. */
async function setup(
  pool: Pool,
  extra: Partial<AppDeps> = {},
): Promise<{ app: FastifyInstance; auth: AuthService }> {
  const db = createDb(pool)
  await migrateToLatest(db)
  const auth = createScryptAuth(db)
  const app = buildApp({
    db,
    auth,
    cookieSecret: SECRET,
    cookieSecure: false,
    ...extra,
  })
  await app.ready()
  return { app, auth }
}

const open = { flags: openFlags() }

const register = (
  app: FastifyInstance,
  payload: Record<string, unknown>,
): ReturnType<FastifyInstance['inject']> =>
  app.inject({ method: 'POST', url: '/api/register', payload }) as ReturnType<
    FastifyInstance['inject']
  >

const GOOD = { username: 'newcomer', password: 'pw-123456', email: 'newcomer@example.com' }

describe('registration', () => {
  it('creates an account, signs the caller in, and never returns the email back', async () => {
    await withTestDatabase(async (pool) => {
      const { app } = await setup(pool, open)

      const res = await register(app, GOOD)
      expect(res.statusCode).toBe(201)
      expect(res.json()).toEqual({ account: { id: expect.any(String), username: 'newcomer' } })
      // the account shape stays {id, username} — email is contact data, not public
      expect(res.body).not.toContain('newcomer@example.com')

      // the response signs you in: the cookie it set resolves to the new account
      const cookie = `cs_session=${res.cookies.find((c) => c.name === 'cs_session')!.value}`
      const me = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } })
      expect(me.statusCode).toBe(200)
      expect(me.json().account.username).toBe('newcomer')

      // and the credential really works through the normal login door
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/login',
            payload: { username: 'newcomer', password: 'pw-123456' },
          })
        ).statusCode,
      ).toBe(200)
      await app.close()
    })
  })

  it('is refused SERVER-side when the flag is off, not merely hidden in the UI', async () => {
    await withTestDatabase(async (pool) => {
      // No flags passed at all — the fail-closed default, every surface shut.
      const { app } = await setup(pool)
      const res = await register(app, GOOD)
      expect(res.statusCode).toBe(403)
      expect(res.json()).toEqual({
        error: { code: 'signup_closed', message: expect.any(String) },
      })
      // Nothing was created. Login is itself gated on this deployment, so the
      // proof is done with login open — otherwise a `surface_disabled` refusal
      // would look like the same 403 whether or not the account exists.
      const { app: withLogin } = await setup(pool, {
        flags: { ...openFlags(), publicSignupEnabled: false },
      })
      expect(
        (
          await withLogin.inject({
            method: 'POST',
            url: '/api/login',
            payload: { username: 'newcomer', password: 'pw-123456' },
          })
        ).statusCode,
      ).toBe(401)
      await withLogin.close()
      await app.close()
    })
  })

  it('refuses explicitly-disabled signup too', async () => {
    await withTestDatabase(async (pool) => {
      const { app } = await setup(pool, { flags: { ...openFlags(), publicSignupEnabled: false } })
      expect((await register(app, GOOD)).statusCode).toBe(403)
      await app.close()
    })
  })

  it('rejects a taken username in any capitalisation, without half-creating an account', async () => {
    await withTestDatabase(async (pool) => {
      const { app, auth } = await setup(pool, open)
      await auth.createAccount('newcomer', 'pw-123456', 'first@example.com')

      const res = await register(app, { ...GOOD, username: 'NewComer' })
      expect(res.statusCode).toBe(409)
      expect(res.json().error.code).toBe('username_taken')

      // the original account is untouched — the failed attempt did not overwrite it
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/login',
            payload: { username: 'newcomer', password: 'pw-123456' },
          })
        ).statusCode,
      ).toBe(200)
      await app.close()
    })
  })

  it('rejects an email already registered in any capitalisation, without echoing it back', async () => {
    await withTestDatabase(async (pool) => {
      const { app, auth } = await setup(pool, open)
      await auth.createAccount('first', 'pw-123456', 'shared@example.com')

      const res = await register(app, { ...GOOD, email: 'Shared@Example.com' })
      expect(res.statusCode).toBe(409)
      expect(res.json().error.code).toBe('email_taken')
      // someone else's address must not come back in the refusal
      expect(res.body).not.toContain('Shared@Example.com')
      expect(res.body).not.toContain('shared@example.com')
      await app.close()
    })
  })

  it('validates the payload server-side', async () => {
    await withTestDatabase(async (pool) => {
      const { app } = await setup(pool, open)
      for (const [label, payload] of [
        ['empty username', { ...GOOD, username: '' }],
        ['short password', { ...GOOD, password: 'short' }],
        ['missing email', { username: 'x', password: 'pw-123456' }],
        ['malformed email', { ...GOOD, email: 'not-an-email' }],
        ['empty body', {}],
      ] as const) {
        const res = await register(app, payload)
        expect(res.statusCode, label).toBe(400)
        expect(res.json().error.code, label).toBe('invalid_request')
      }
      await app.close()
    })
  })

  it('goes through the same hashing path as the operator CLI', async () => {
    await withTestDatabase(async (pool) => {
      const { app, auth } = await setup(pool, open)
      await register(app, GOOD)

      const db = createDb(pool)
      const row = await db
        .selectFrom('accounts')
        .select('password_hash')
        .where('username', '=', 'newcomer')
        .executeTakeFirstOrThrow()
      // the self-describing scrypt format createAccount produces — not a second
      // weaker implementation living behind the web route
      expect(row.password_hash).toMatch(/^scrypt\$\d+\$\d+\$\d+\$/)
      // and the service can verify it, which is the real proof of one door
      expect(
        await auth.verifyAccountPassword(
          (await auth.login('newcomer', 'pw-123456'))!.account.id,
          'pw-123456',
        ),
      ).toBe(true)
      await app.close()
    })
  })
})
