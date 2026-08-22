import type { Kysely } from 'kysely'
import type { Database } from '../db/schema'
import type { PublicAccount } from './types'

/** Session rows are GLOBAL like accounts; the repo takes a bare `Kysely`. */

export async function insertSession(
  db: Kysely<Database>,
  row: {
    id: string
    account_id: string
    expires_at: Date
    last_seen_at?: Date
    device_label?: string | null
  },
): Promise<void> {
  await db.insertInto('auth_sessions').values(row).execute()
}

export async function deleteSession(db: Kysely<Database>, id: string): Promise<void> {
  await db.deleteFrom('auth_sessions').where('id', '=', id).execute()
}

/** End every session for an account (reset / revoke-all from a lost device). */
export async function deleteSessionsForAccount(
  db: Kysely<Database>,
  accountId: string,
): Promise<void> {
  await db.deleteFrom('auth_sessions').where('account_id', '=', accountId).execute()
}

/**
 * End every session for an account EXCEPT one — the primitive behind password
 * change and revoke-all, both of which must leave the caller signed in on the
 * device they are standing at.
 */
export async function deleteOtherSessionsForAccount(
  db: Kysely<Database>,
  accountId: string,
  exceptSessionId: string,
): Promise<void> {
  await db
    .deleteFrom('auth_sessions')
    .where('account_id', '=', accountId)
    .where('id', '!=', exceptSessionId)
    .execute()
}

/**
 * Drop an account's already-expired session rows. Expiry is enforced at read
 * time regardless; this is what stops the table growing without bound, and it
 * runs at the moments the account is already being touched (login, session
 * listing) rather than from a background timer.
 */
export async function deleteExpiredSessionsForAccount(
  db: Kysely<Database>,
  accountId: string,
  now: Date,
): Promise<void> {
  await db
    .deleteFrom('auth_sessions')
    .where('account_id', '=', accountId)
    .where('expires_at', '<=', now)
    .execute()
}

/** A live session row as the account-settings list needs it. */
export interface SessionRow {
  id: string
  created_at: Date
  last_seen_at: Date
  device_label: string | null
}

/** An account's unexpired sessions, most recently used first. */
export function listSessionsForAccount(
  db: Kysely<Database>,
  accountId: string,
  now: Date,
): Promise<SessionRow[]> {
  return db
    .selectFrom('auth_sessions')
    .where('account_id', '=', accountId)
    .where('expires_at', '>', now)
    .select(['id', 'created_at', 'last_seen_at', 'device_label'])
    .orderBy('last_seen_at', 'desc')
    .execute()
}

/** Record that a session was just used (throttled by the caller). */
export async function touchSession(
  db: Kysely<Database>,
  sessionId: string,
  now: Date,
): Promise<void> {
  await db
    .updateTable('auth_sessions')
    .set({ last_seen_at: now })
    .where('id', '=', sessionId)
    .execute()
}

/** The account behind a session plus the row's own recency bookkeeping. */
export interface SessionAccount {
  account: PublicAccount
  lastSeenAt: Date
}

/**
 * The public account behind a session, iff the session exists and has not
 * expired. Expiry is enforced in SQL against the caller-supplied `now` (the
 * clock seam), and the FK guarantees a matching account, so there is no
 * "session without account" state to handle. `last_seen_at` rides along so the
 * caller can decide whether the row is stale enough to be worth a write.
 */
export async function getSessionAccount(
  db: Kysely<Database>,
  sessionId: string,
  now: Date,
): Promise<SessionAccount | undefined> {
  const row = await db
    .selectFrom('auth_sessions')
    .innerJoin('accounts', 'accounts.id', 'auth_sessions.account_id')
    .where('auth_sessions.id', '=', sessionId)
    .where('auth_sessions.expires_at', '>', now)
    .select([
      'accounts.id as id',
      'accounts.username as username',
      'auth_sessions.last_seen_at as last_seen_at',
    ])
    .executeTakeFirst()
  if (!row) return undefined
  return { account: { id: row.id, username: row.username }, lastSeenAt: row.last_seen_at }
}
