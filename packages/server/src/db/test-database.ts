import { randomUUID } from 'node:crypto'
import type { Kysely } from 'kysely'
import type { Pool } from 'pg'
import { createPool } from './pool'
import type { Database } from './schema'

/** Read DATABASE_URL or fail with an actionable message. */
export function requireDatabaseUrl(): string {
  const url = process.env.DATABASE_URL
  if (!url) {
    throw new Error(
      'DATABASE_URL is not set — run `docker compose up -d` and copy .env.example to .env',
    )
  }
  return url
}

function withDatabaseName(connectionString: string, dbName: string): string {
  const url = new URL(connectionString)
  url.pathname = `/${dbName}`
  return url.toString()
}

/**
 * Provision a freshly-created, isolated database, run `fn` against a pool bound
 * to it, then drop it — no testcontainers, just a real Postgres reachable at
 * `connectionString` (defaults to DATABASE_URL). Each call gets its own DB so
 * suites never share state.
 */
export async function withTestDatabase<T>(
  fn: (pool: Pool) => Promise<T>,
  connectionString: string = requireDatabaseUrl(),
): Promise<T> {
  const dbName = `cs_test_${randomUUID().replace(/-/g, '')}`
  const adminPool = createPool(withDatabaseName(connectionString, 'postgres'))
  // A pg Pool with no 'error' listener crashes the process on any idle-client
  // error. Teardown below drops the test DB WITH (FORCE), which terminates the
  // test pool's idle connections (57P01); that is expected and must not surface
  // as an unhandled error. Swallow idle-client errors on both pools.
  adminPool.on('error', () => {})
  try {
    await adminPool.query(`CREATE DATABASE "${dbName}"`)
    const testPool = createPool(withDatabaseName(connectionString, dbName))
    testPool.on('error', () => {})
    try {
      return await fn(testPool)
    } finally {
      await testPool.end()
      await adminPool.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`)
    }
  } finally {
    await adminPool.end()
  }
}

/**
 * Mark an account's email verified, for suites whose subject is downstream of
 * verification (invitations, deletion) rather than verification itself.
 *
 * Registering through the API leaves an account unverified until it clicks the
 * emailed link, and world creation is gated on that — so a setup that mints an
 * account WITH an email and then creates a world has to do what a real user
 * does. Suites that create accounts with no email need none of this: an account
 * with no address has nothing to prove.
 */
export async function markEmailVerified(
  db: Kysely<Database>,
  accountId: string,
  at = new Date(),
): Promise<void> {
  await db
    .updateTable('accounts')
    .set({ email_verified_at: at })
    .where('id', '=', accountId)
    .execute()
}
