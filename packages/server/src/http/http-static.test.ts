import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createScryptAuth } from '../auth/service'
import { createDb } from '../db/kysely'
import { migrateToLatest } from '../db/migrator'
import { openFlags } from '../flags/config'
import { withTestDatabase } from '../db/test-database'
import { buildApp } from './app'

const SECRET = 'test-secret-test-secret-test-secret'

// A throwaway built-SPA dir: an index shell + one hashed asset.
let distDir: string
let secretPath: string
beforeAll(() => {
  distDir = mkdtempSync(join(tmpdir(), 'cs-dist-'))
  mkdirSync(join(distDir, 'assets'))
  writeFileSync(join(distDir, 'index.html'), '<!doctype html><title>spa shell</title>')
  writeFileSync(join(distDir, 'assets', 'app.js'), 'console.log("asset")')
  // A file OUTSIDE the served root, as a traversal target. Written beside the
  // dist dir rather than in it, so any response containing this string means
  // the static handler escaped its root.
  secretPath = join(tmpdir(), `cs-outside-${process.pid}.txt`)
  writeFileSync(secretPath, 'OUTSIDE-THE-ROOT')
})
afterAll(() => {
  rmSync(distDir, { recursive: true, force: true })
  rmSync(secretPath, { force: true })
})

describe('static SPA serving (webDistDir)', () => {
  it('serves assets, falls back to index.html for client routes, keeps /api JSON 404', async () => {
    await withTestDatabase(async (pool) => {
      const db = createDb(pool)
      await migrateToLatest(db)
      const app = buildApp({
        db,
        auth: createScryptAuth(db),
        cookieSecret: SECRET,
        cookieSecure: false,
        // This suite's subject is the flow, not the access gate — flags ship
        // fail-closed, and restating the policy in every setup is how setups
        // drift from the real defaults. The gate has its own suite.
        flags: openFlags(),
        webDistDir: distDir,
      })
      await app.ready()
      try {
        // a real built asset is served from disk
        const asset = await app.inject({ method: 'GET', url: '/assets/app.js' })
        expect(asset.statusCode).toBe(200)
        expect(asset.body).toContain('console.log')

        // an unknown GET that isn't an API call is a client-side route → SPA shell
        const deep = await app.inject({ method: 'GET', url: '/worlds/abc/npc' })
        expect(deep.statusCode).toBe(200)
        expect(deep.body).toContain('spa shell')

        // unknown API routes stay a JSON 404 (never the SPA shell)
        const api404 = await app.inject({ method: 'GET', url: '/api/nope' })
        expect(api404.statusCode).toBe(404)
        expect(api404.json()).toEqual({ error: { code: 'not_found', message: 'not found' } })

        // a non-GET unknown route is also a JSON 404, not the shell
        const del404 = await app.inject({ method: 'DELETE', url: '/whatever' })
        expect(del404.statusCode).toBe(404)
        expect(del404.json().error.code).toBe('not_found')
      } finally {
        await app.close()
      }
    })
  })

  /**
   * The regression net for bug 1206's @fastify/static bump (9.1.3 -> 10.1.2).
   * Both advisories that forced the major are about the static handler serving
   * something it should not: one via path traversal, one via non-canonical URL
   * paths that slip past a route guard. This app registers it with
   * `wildcard: false` plus a custom setNotFoundHandler, which is exactly that
   * area — so the upgrade is not "assumed fine because the suite is green",
   * it is checked here.
   *
   * Note what the assertions are: never the file's contents, and never a
   * specific status. A traversal that 404s and one that redirects are both
   * acceptable outcomes; serving OUTSIDE-THE-ROOT is not, and neither is
   * handing back the SPA shell for a path that names the API.
   */
  it('does not serve files outside the dist root, however the path is spelled', async () => {
    await withTestDatabase(async (pool) => {
      const db = createDb(pool)
      await migrateToLatest(db)
      const app = buildApp({
        db,
        auth: createScryptAuth(db),
        cookieSecret: SECRET,
        cookieSecure: false,
        flags: openFlags(),
        webDistDir: distDir,
      })
      await app.ready()
      try {
        const outside = basename(secretPath)
        for (const url of [
          `/../${outside}`,
          `/..%2f${outside}`,
          `/%2e%2e/${outside}`,
          `/assets/../../${outside}`,
          `/assets/..%2f..%2f${outside}`,
          `/.%2e/${outside}`,
          `//../${outside}`,
        ]) {
          const res = await app.inject({ method: 'GET', url })
          expect(res.body, `traversal escaped the root via ${url}`).not.toContain(
            'OUTSIDE-THE-ROOT',
          )
        }
      } finally {
        await app.close()
      }
    })
  })

  it('never lets a non-canonical path turn an /api route into the SPA shell', async () => {
    await withTestDatabase(async (pool) => {
      const db = createDb(pool)
      await migrateToLatest(db)
      const app = buildApp({
        db,
        auth: createScryptAuth(db),
        cookieSecret: SECRET,
        cookieSecure: false,
        flags: openFlags(),
        webDistDir: distDir,
      })
      await app.ready()
      try {
        // The SPA fallback keys on `req.url.startsWith('/api')`. An encoded or
        // doubled-slash spelling that the router treats as /api but that string
        // check does not would hand an unauthenticated caller the shell instead
        // of a JSON 404 — harmless on its own, but it is the same class of
        // confusion the non-canonical-path advisory describes, so pin it.
        for (const url of ['/api/nope', '/api//nope', '/api/./nope']) {
          const res = await app.inject({ method: 'GET', url })
          expect(res.body, `${url} served the SPA shell`).not.toContain('spa shell')
        }
      } finally {
        await app.close()
      }
    })
  })
})
