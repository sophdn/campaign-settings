import { describe, expect, it } from 'vitest'
import { createScryptAuth } from '../auth/service'
import { createDb } from '../db/kysely'
import { createPool } from '../db/pool'
import { allFlags, openFlags } from '../flags/config'
import { type AppDeps, DEFAULT_CONTACT_EMAIL, buildApp } from './app'

const SECRET = 'test-secret-test-secret-test-secret'

// `/api/config` touches neither auth nor the DB, so these tests build the app
// over an unconnected pool (pg connects lazily) and never issue a query — no
// live Postgres required.
function appWith(extra: Partial<Pick<AppDeps, 'flags' | 'contactEmail'>> = {}) {
  const db = createDb(createPool('postgres://unused:unused@127.0.0.1:1/none'))
  const app = buildApp({
    db,
    auth: createScryptAuth(db),
    cookieSecret: SECRET,
    cookieSecure: false,
    ...extra,
  })
  return { app, db }
}

describe('GET /api/config (public runtime config)', () => {
  it('reflects the flags and contact email passed in deps, with no auth or session', async () => {
    const { app, db } = appWith({
      flags: openFlags(),
      contactEmail: 'help@example.com',
    })
    await app.ready()
    try {
      const res = await app.inject({ method: 'GET', url: '/api/config' })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({
        flags: openFlags(),
        contactEmail: 'help@example.com',
      })
    } finally {
      await app.close()
      await db.destroy()
    }
  })

  it('falls back to fail-closed flags and the default contact email when omitted', async () => {
    const { app, db } = appWith()
    await app.ready()
    try {
      const res = await app.inject({ method: 'GET', url: '/api/config' })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({
        // EVERY flag closed, not just signup — a deployment that passes no
        // flags must expose no gated surface at all.
        flags: allFlags(false),
        contactEmail: DEFAULT_CONTACT_EMAIL,
      })
    } finally {
      await app.close()
      await db.destroy()
    }
  })
})
