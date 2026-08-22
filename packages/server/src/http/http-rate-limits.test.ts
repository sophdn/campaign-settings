import type { FastifyInstance } from 'fastify'
import type { Pool } from 'pg'
import { describe, expect, it } from 'vitest'
import { createScryptAuth } from '../auth/service'
import { createDb } from '../db/kysely'
import { migrateToLatest } from '../db/migrator'
import { withTestDatabase } from '../db/test-database'
import { openFlags } from '../flags/config'
import { buildApp } from './app'
import { DEFAULT_RATE_LIMITS } from './rate-limits'

const SECRET = 'test-secret-test-secret-test-secret'

/**
 * Rate limiting on the anonymous-reachable surface (task 3551).
 *
 * The ceilings are lowered through AppDeps so a limit is reachable in three
 * requests instead of the production quota's ten-per-ten-minutes. Every test
 * here fires ONE more request than the ceiling allows and asserts the refusal,
 * because a limit that never refuses is indistinguishable from no limit — and
 * "the route works perfectly and is simply not limited" is exactly the failure
 * @fastify/rate-limit's registration order can produce.
 */
async function setup(pool: Pool, max = 2): Promise<{ app: FastifyInstance }> {
  const db = createDb(pool)
  await migrateToLatest(db)
  const app = buildApp({
    db,
    auth: createScryptAuth(db),
    cookieSecret: SECRET,
    cookieSecure: false,
    flags: openFlags(),
    rateLimits: {
      auth: { max, timeWindow: 60_000 },
      mail: { max, timeWindow: 60_000 },
      token: { max, timeWindow: 60_000 },
      lookup: { max, timeWindow: 60_000 },
    },
  })
  await app.ready()
  return { app }
}

/** Fire `n` requests from one caller and return the status codes in order. */
async function fire(
  app: FastifyInstance,
  n: number,
  req: { method: 'GET' | 'POST'; url: string; payload?: unknown },
  remoteAddress = '203.0.113.10',
): Promise<number[]> {
  const codes: number[] = []
  for (let i = 0; i < n; i++) {
    const res = await app.inject({
      method: req.method,
      url: req.url,
      remoteAddress,
      ...(req.payload ? { payload: req.payload } : {}),
    })
    codes.push(res.statusCode)
  }
  return codes
}

describe('rate limits on the routes a stranger can reach', () => {
  it('refuses the attempt after the ceiling, in the same error envelope as everything else', async () => {
    await withTestDatabase(async (pool) => {
      const { app } = await setup(pool)

      const bad = { username: 'nobody', password: 'wrong-password-1' }
      await fire(app, 2, { method: 'POST', url: '/api/login', payload: bad })
      const res = await app.inject({
        method: 'POST',
        url: '/api/login',
        remoteAddress: '203.0.113.10',
        payload: bad,
      })

      expect(res.statusCode).toBe(429)
      expect(res.json().error.code).toBe('rate_limited')
    })
  })

  /**
   * The point of the limit is to slow ONE caller. If the bucket were shared,
   * the first abuser would lock out everybody — which is the failure mode a
   * proxy-blinded `req.ip` produces (see AppDeps.trustProxy).
   */
  it('keys the ceiling per caller, so one abuser does not lock out everyone', async () => {
    await withTestDatabase(async (pool) => {
      const { app } = await setup(pool)
      const bad = { username: 'nobody', password: 'wrong-password-1' }

      const abuser = await fire(app, 4, { method: 'POST', url: '/api/login', payload: bad })
      expect(abuser.filter((c) => c === 429).length).toBeGreaterThan(0)

      const bystander = await fire(
        app,
        1,
        { method: 'POST', url: '/api/login', payload: bad },
        '198.51.100.7',
      )
      expect(bystander).toEqual([401])
    })
  })

  it('limits registration, which is the more expensive of the two doors', async () => {
    await withTestDatabase(async (pool) => {
      const { app } = await setup(pool)

      const codes = await fire(app, 4, {
        method: 'POST',
        url: '/api/register',
        payload: { username: 'x', password: 'short', email: 'not-an-email' },
      })

      expect(codes.at(-1)).toBe(429)
    })
  })

  it('limits the demo door, which mints a session with no credentials at all', async () => {
    await withTestDatabase(async (pool) => {
      const { app } = await setup(pool)
      const codes = await fire(app, 4, { method: 'POST', url: '/api/demo-login' })
      expect(codes.at(-1)).toBe(429)
    })
  })

  /**
   * The per-ACCOUNT throttle already stops one mailbox being flooded. It cannot
   * see a caller walking a list of addresses, because no account repeats — this
   * is the axis that catches that.
   */
  it('limits password-reset requests, which send mail to an address the caller picks', async () => {
    await withTestDatabase(async (pool) => {
      const { app } = await setup(pool)

      const codes: number[] = []
      for (const who of ['a@example.com', 'b@example.com', 'c@example.com', 'd@example.com']) {
        const res = await app.inject({
          method: 'POST',
          url: '/api/password-reset/request',
          remoteAddress: '203.0.113.10',
          payload: { identifier: who },
        })
        codes.push(res.statusCode)
      }

      expect(codes.at(-1)).toBe(429)
    })
  })

  it('limits guesses at opaque tokens — invitation preview, reset confirm, verification', async () => {
    await withTestDatabase(async (pool) => {
      const { app } = await setup(pool)

      expect((await fire(app, 4, { method: 'GET', url: '/api/invitations/guess' })).at(-1)).toBe(
        429,
      )
      expect(
        (
          await fire(
            app,
            4,
            {
              method: 'POST',
              url: '/api/password-reset/confirm',
              payload: { token: 'guess', newPassword: 'new-password-12' },
            },
            '198.51.100.8',
          )
        ).at(-1),
      ).toBe(429)
      expect(
        (
          await fire(
            app,
            4,
            { method: 'POST', url: '/api/verify-email', payload: { token: 'guess' } },
            '198.51.100.9',
          )
        ).at(-1),
      ).toBe(429)
    })
  })

  it('gives each route its own bucket — spending one door does not close another', async () => {
    await withTestDatabase(async (pool) => {
      const { app } = await setup(pool)

      const codes = await fire(app, 4, { method: 'POST', url: '/api/demo-login' })
      expect(codes.at(-1)).toBe(429)

      // login from the SAME caller is untouched: it has its own ceiling
      const login = await app.inject({
        method: 'POST',
        url: '/api/login',
        remoteAddress: '203.0.113.10',
        payload: { username: 'nobody', password: 'wrong-password-1' },
      })
      expect(login.statusCode).toBe(401)
    })
  })
})

describe('trustProxy', () => {
  /**
   * Behind a reverse proxy the socket's peer address is the PROXY's, identical
   * for every visitor. Without trustProxy every IP-keyed ceiling above collapses
   * into one bucket and the first abuser locks out the internet.
   */
  it('is off by default, so a caller cannot pick their own rate-limit key', async () => {
    await withTestDatabase(async (pool) => {
      const { app } = await setup(pool)
      const bad = { username: 'nobody', password: 'wrong-password-1' }
      await fire(app, 3, { method: 'POST', url: '/api/login', payload: bad })

      // a forged header does NOT buy a fresh bucket
      const res = await app.inject({
        method: 'POST',
        url: '/api/login',
        remoteAddress: '203.0.113.10',
        headers: { 'x-forwarded-for': '198.51.100.99' },
        payload: bad,
      })
      expect(res.statusCode).toBe(429)
    })
  })

  it('reads the forwarded address when the deployment says a proxy is in front', async () => {
    await withTestDatabase(async (pool) => {
      const db = createDb(pool)
      await migrateToLatest(db)
      const app = buildApp({
        db,
        auth: createScryptAuth(db),
        cookieSecret: SECRET,
        cookieSecure: false,
        flags: openFlags(),
        rateLimits: { ...DEFAULT_RATE_LIMITS, auth: { max: 2, timeWindow: 60_000 } },
        trustProxy: true,
      })
      await app.ready()
      const bad = { username: 'nobody', password: 'wrong-password-1' }

      // three requests down one forwarded address exhausts THAT caller
      const spend = async (forwarded: string): Promise<number> =>
        (
          await app.inject({
            method: 'POST',
            url: '/api/login',
            remoteAddress: '192.0.2.1', // the proxy, the same every time
            headers: { 'x-forwarded-for': forwarded },
            payload: bad,
          })
        ).statusCode

      for (let i = 0; i < 3; i++) await spend('198.51.100.1')
      expect(await spend('198.51.100.1')).toBe(429)
      // and a DIFFERENT visitor behind the same proxy is unaffected
      expect(await spend('198.51.100.2')).toBe(401)
    })
  })
})
