import type { FastifyInstance } from 'fastify'
import type { Pool } from 'pg'
import { describe, expect, it } from 'vitest'
import type { Mailer, PasswordResetMail } from '../auth/mailer'
import { createScryptAuth } from '../auth/service'
import type { AuthService } from '../auth/types'
import { createDb } from '../db/kysely'
import { migrateToLatest } from '../db/migrator'
import { openFlags } from '../flags/config'
import { withTestDatabase } from '../db/test-database'
import { type AppDeps, buildApp } from './app'

const SECRET = 'test-secret-test-secret-test-secret'

function fakeMailer(): { mailer: Mailer; sent: PasswordResetMail[] } {
  const sent: PasswordResetMail[] = []
  return {
    sent,
    mailer: {
      sendPasswordReset(mail: PasswordResetMail): Promise<void> {
        sent.push(mail)
        return Promise.resolve()
      },
      sendEmailVerification(): Promise<void> {
        return Promise.resolve()
      },
    },
  }
}

async function setup(
  pool: Pool,
  extra: Partial<AppDeps> = {},
): Promise<{ app: FastifyInstance; auth: AuthService; sent: PasswordResetMail[] }> {
  const db = createDb(pool)
  await migrateToLatest(db)
  const auth = createScryptAuth(db)
  const { mailer, sent } = fakeMailer()
  const app = buildApp({
    db,
    auth,
    cookieSecret: SECRET,
    cookieSecure: false,
    // This suite's subject is the flow, not the access gate — flags ship
    // fail-closed, and restating the policy in every setup is how setups
    // drift from the real defaults. The gate has its own suite.
    flags: openFlags(),
    mailer,
    ...extra,
  })
  await app.ready()
  return { app, auth, sent }
}

const cookieOf = (res: { cookies: { name: string; value: string }[] }): string =>
  `cs_session=${res.cookies.find((c) => c.name === 'cs_session')!.value}`

describe('password reset', () => {
  it('emails a token, resets the password on confirm, and invalidates existing sessions', async () => {
    await withTestDatabase(async (pool) => {
      const { app, auth, sent } = await setup(pool)
      await auth.createAccount('dm', 'old-password-1', 'dm@example.com')

      const login = await app.inject({
        method: 'POST',
        url: '/api/login',
        payload: { username: 'dm', password: 'old-password-1' },
      })
      const cookie = cookieOf(login)
      expect(
        (await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } })).statusCode,
      ).toBe(200)

      // request by EMAIL → one mail with a token
      const req = await app.inject({
        method: 'POST',
        url: '/api/password-reset/request',
        payload: { identifier: 'dm@example.com' },
      })
      expect(req.statusCode).toBe(200)
      expect(req.json()).toEqual({ ok: true })
      expect(sent).toHaveLength(1)
      expect(sent[0]!.to).toBe('dm@example.com')

      const confirm = await app.inject({
        method: 'POST',
        url: '/api/password-reset/confirm',
        payload: { token: sent[0]!.token, newPassword: 'new-password-2' },
      })
      expect(confirm.statusCode).toBe(200)

      // the pre-reset session is dead, old password fails, new password works
      expect(
        (await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } })).statusCode,
      ).toBe(401)
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

  it('does not reveal whether an account exists (identical response; mail only for a real one)', async () => {
    await withTestDatabase(async (pool) => {
      const { app, auth, sent } = await setup(pool)
      await auth.createAccount('dm', 'old-password-1', 'dm@example.com')

      const real = await app.inject({
        method: 'POST',
        url: '/api/password-reset/request',
        payload: { identifier: 'dm' }, // resolves by USERNAME
      })
      const ghost = await app.inject({
        method: 'POST',
        url: '/api/password-reset/request',
        payload: { identifier: 'nobody' },
      })

      expect(real.statusCode).toBe(ghost.statusCode)
      expect(real.json()).toEqual(ghost.json())
      expect(real.json()).toEqual({ ok: true })
      expect(sent).toHaveLength(1) // only the account that exists produced mail
      expect(sent[0]!.to).toBe('dm@example.com')
      await app.close()
    })
  })

  it('responds the same for an account with no email but sends no mail', async () => {
    await withTestDatabase(async (pool) => {
      const { app, auth, sent } = await setup(pool)
      await auth.createAccount('noemail', 'old-password-1') // no email

      const res = await app.inject({
        method: 'POST',
        url: '/api/password-reset/request',
        payload: { identifier: 'noemail' },
      })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ ok: true })
      expect(sent).toHaveLength(0)
      await app.close()
    })
  })

  it('throttles rapid requests to one mail per account', async () => {
    await withTestDatabase(async (pool) => {
      const clock = new Date('2026-01-01T00:00:00Z')
      const { app, auth, sent } = await setup(pool, { now: () => clock })
      await auth.createAccount('dm', 'old-password-1', 'dm@example.com')

      const body = { identifier: 'dm@example.com' }
      await app.inject({ method: 'POST', url: '/api/password-reset/request', payload: body })
      await app.inject({ method: 'POST', url: '/api/password-reset/request', payload: body })
      expect(sent).toHaveLength(1) // the second request was throttled
      await app.close()
    })
  })

  it('rejects an unknown token and a too-short password without consuming the token', async () => {
    await withTestDatabase(async (pool) => {
      const { app, auth, sent } = await setup(pool)
      await auth.createAccount('dm', 'old-password-1', 'dm@example.com')

      const bad = await app.inject({
        method: 'POST',
        url: '/api/password-reset/confirm',
        payload: { token: 'not-a-real-token', newPassword: 'long-enough-1' },
      })
      expect(bad.statusCode).toBe(400)
      expect(bad.json()).toEqual({
        error: { code: 'invalid_or_expired_token', message: expect.any(String) },
      })

      await app.inject({
        method: 'POST',
        url: '/api/password-reset/request',
        payload: { identifier: 'dm@example.com' },
      })
      const token = sent[0]!.token
      // too short → rejected before the token is consumed
      const short = await app.inject({
        method: 'POST',
        url: '/api/password-reset/confirm',
        payload: { token, newPassword: 'short' },
      })
      expect(short.statusCode).toBe(400)
      // the token survived: a valid-length retry still succeeds
      const ok = await app.inject({
        method: 'POST',
        url: '/api/password-reset/confirm',
        payload: { token, newPassword: 'long-enough-1' },
      })
      expect(ok.statusCode).toBe(200)
      await app.close()
    })
  })
})
