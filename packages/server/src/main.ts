/**
 * Production entrypoint: the one place that reads the environment, opens the
 * real Postgres pool, applies migrations, and starts listening. Everything it
 * wires (buildApp, createScryptAuth, loadAuthConfig) is pure/IO-free and unit
 * tested on its own; this file is the thin, untested IO shell around them.
 *
 * Run it with node (no pnpm at boot):
 *   node --import tsx packages/server/src/main.ts
 *
 * Required env: DATABASE_URL, SESSION_SECRET (>=32 chars).
 * Optional env: PORT (default 8787), HOST (default 127.0.0.1), SESSION_TTL_DAYS,
 *               NODE_ENV (set `production` to flag the session cookie Secure),
 *               WEB_DIST_DIR (absolute path to the built SPA — serve it single-origin).
 */
import { loadAuthConfig } from './auth/config'
import { createScryptAuth } from './auth/service'
import { createDb } from './db/kysely'
import { migrateToLatest } from './db/migrator'
import { createPool } from './db/pool'
import { loadFlags } from './flags/config'
import { buildApp } from './http/app'

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) throw new Error('DATABASE_URL must be set')

const authConfig = loadAuthConfig()
const port = process.env.PORT === undefined ? 8787 : Number(process.env.PORT)
if (!Number.isInteger(port) || port <= 0) throw new Error('PORT must be a positive integer')
const host = process.env.HOST ?? '127.0.0.1'

// The db owns the pool (PostgresDialect); db.destroy() ends it — never end twice.
const db = createDb(createPool(databaseUrl))
await migrateToLatest(db)

const app = buildApp({
  db,
  auth: createScryptAuth(db, { sessionTtlMs: authConfig.sessionTtlMs }),
  cookieSecret: authConfig.cookieSecret,
  cookieSecure: authConfig.cookieSecure,
  flags: loadFlags(),
  ...(process.env.CONTACT_EMAIL ? { contactEmail: process.env.CONTACT_EMAIL } : {}),
  ...(process.env.DEMO_USERNAME ? { demoUsername: process.env.DEMO_USERNAME } : {}),
  ...(process.env.WEB_DIST_DIR ? { webDistDir: process.env.WEB_DIST_DIR } : {}),
})

// Graceful shutdown so systemd restarts/stops drain in-flight requests cleanly.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    void (async () => {
      await app.close()
      await db.destroy()
      process.exit(0)
    })()
  })
}

await app.listen({ port, host })
console.log(`campaign-settings server listening on http://${host}:${port}`)
