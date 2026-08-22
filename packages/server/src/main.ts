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
 *               TRUST_PROXY (hop count, or `true`, when a reverse proxy is in front),
 *               WEB_DIST_DIR (absolute path to the built SPA — serve it single-origin).
 */
import { loadAuthConfig } from './auth/config'
import { createScryptAuth } from './auth/service'
import { createDb } from './db/kysely'
import { migrateToLatest } from './db/migrator'
import { createPool } from './db/pool'
import { loadFlags } from './flags/config'
import { buildApp } from './http/app'
import { resendMailerFromEnv } from './auth/resend-mailer'
import { loadRateLimits } from './http/rate-limits'
import { parseTrustProxy } from './http/trust-proxy'

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) throw new Error('DATABASE_URL must be set')

const authConfig = loadAuthConfig()
const port = process.env.PORT === undefined ? 8787 : Number(process.env.PORT)
if (!Number.isInteger(port) || port <= 0) throw new Error('PORT must be a positive integer')
const host = process.env.HOST ?? '127.0.0.1'
// Unset means trust nothing, which is right for a directly-reached deployment
// and wrong behind Caddy, where it makes every IP-keyed rate limit one shared
// bucket. See DEPLOY.md §"Behind a reverse proxy".
const trustProxy = parseTrustProxy(process.env.TRUST_PROXY)
// Built before the database is touched: a half-configured provider throws, and
// it should throw on the way up rather than at the first password reset.
const mailer = resendMailerFromEnv(process.env)

// The db owns the pool (PostgresDialect); db.destroy() ends it — never end twice.
const db = createDb(createPool(databaseUrl))
await migrateToLatest(db)

const app = buildApp({
  db,
  auth: createScryptAuth(db, { sessionTtlMs: authConfig.sessionTtlMs }),
  cookieSecret: authConfig.cookieSecret,
  cookieSecure: authConfig.cookieSecure,
  flags: loadFlags(),
  rateLimits: loadRateLimits(),
  trustProxy,
  // The real provider when the box carries one, otherwise buildApp's logging
  // no-op. Constructed HERE and not inside buildApp, so the app depends on the
  // Mailer port and never on a provider — swapping Resend for another means a
  // new adapter and a changed line in this file, nothing else.
  ...(mailer ? { mailer } : {}),
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
