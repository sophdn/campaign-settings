import { randomBytes } from 'node:crypto'
import type { Kysely } from 'kysely'
import { newId } from '../db/ids'
import { type BlockingWorld, deleteAccount, worldsBlockingDeletion } from './deletion'
import type { Database } from '../db/schema'
import {
  getAccountByEmail,
  getAccountById,
  getAccountByUsername,
  insertAccount,
  setAccountPassword,
  setAccountUsername,
} from './accounts'
import { hashPassword, verifyPassword } from './password'
import {
  deleteExpiredSessionsForAccount,
  deleteOtherSessionsForAccount,
  deleteSession,
  deleteSessionsForAccount,
  getSessionAccount,
  insertSession,
  listSessionsForAccount,
  touchSession,
} from './sessions'
import {
  type AuthService,
  DuplicateEmailError,
  DuplicateUsernameError,
  type LoginResult,
  type PublicAccount,
  type SessionMeta,
  type SessionSummary,
} from './types'

const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000

/**
 * How stale `last_seen_at` must be before an authenticated request pays for a
 * write. Without this, session recency would cost a row update on EVERY request
 * — the session list is worth minutes of precision, not that.
 */
const LAST_SEEN_REFRESH_MS = 5 * 60 * 1000

export interface ScryptAuthOptions {
  /** Session lifetime in milliseconds (default 30 days). */
  sessionTtlMs?: number
  /** Clock seam — overridden in tests to exercise expiry deterministically. */
  now?: () => Date
}

/**
 * The scrypt + session-cookie implementation of {@link AuthService} over the
 * kysely DB. This factory is the hot-swap point: a future provider implements
 * the same interface and nothing downstream changes.
 */
export function createScryptAuth(
  db: Kysely<Database>,
  options: ScryptAuthOptions = {},
): AuthService {
  const ttlMs = options.sessionTtlMs ?? DEFAULT_TTL_MS
  const now = options.now ?? ((): Date => new Date())

  /** Open a session row for an account and return its id. */
  async function openSession(accountId: string, meta: SessionMeta | undefined): Promise<string> {
    const sessionId = randomBytes(32).toString('base64url')
    const at = now()
    await insertSession(db, {
      id: sessionId,
      account_id: accountId,
      expires_at: new Date(at.getTime() + ttlMs),
      last_seen_at: at,
      device_label: meta?.deviceLabel ?? null,
    })
    return sessionId
  }

  return {
    sessionTtlMs: ttlMs,

    async createAccount(
      username: string,
      password: string,
      email?: string | null,
    ): Promise<PublicAccount> {
      // Hash BEFORE the duplicate checks. scrypt dominates this operation, so
      // rejecting early would make a taken name measurably faster to probe than
      // a free one — a timing oracle on an endpoint strangers can reach. Paying
      // the hash on both paths costs one wasted derivation per duplicate and
      // collapses the difference to a query. It is not constant-time and does
      // not claim to be; it removes the part an attacker could actually measure
      // over a network.
      const passwordHash = await hashPassword(password)

      // Pre-checks give the friendly error; the DB indexes are the backstop for
      // a concurrent race (they error, never overwrite). Both comparisons are
      // case-insensitive — lower(username) since 0009, lower(email) since 0006 —
      // so neither `Sophi` nor `DM@Example.com` can shadow an existing account.
      if (await getAccountByUsername(db, username)) throw new DuplicateUsernameError(username)
      if (email != null && (await getAccountByEmail(db, email))) throw new DuplicateEmailError()

      const id = newId()
      await insertAccount(db, {
        id,
        username,
        password_hash: passwordHash,
        ...(email != null ? { email } : {}),
      })
      return { id, username }
    },

    startSession(accountId: string, meta?: SessionMeta): Promise<string> {
      return openSession(accountId, meta)
    },

    async login(
      username: string,
      password: string,
      meta?: SessionMeta,
    ): Promise<LoginResult | null> {
      const account = await getAccountByUsername(db, username)
      if (!account) return null
      if (!(await verifyPassword(password, account.password_hash))) return null
      // Reap here: this is the one place a session row is born, so cleaning up
      // on the way in bounds each account's dead rows to those made since its
      // last sign-in. No timer, no table scan.
      await deleteExpiredSessionsForAccount(db, account.id, now())
      const sessionId = await openSession(account.id, meta)
      return { sessionId, account: { id: account.id, username: account.username } }
    },

    async authenticate(sessionId: string): Promise<PublicAccount | null> {
      const at = now()
      const found = await getSessionAccount(db, sessionId, at)
      if (!found) return null
      if (at.getTime() - found.lastSeenAt.getTime() >= LAST_SEEN_REFRESH_MS) {
        await touchSession(db, sessionId, at)
      }
      return found.account
    },

    async logout(sessionId: string): Promise<void> {
      await deleteSession(db, sessionId)
    },

    async setPassword(accountId: string, newPassword: string): Promise<void> {
      await setAccountPassword(db, accountId, await hashPassword(newPassword))
    },

    async invalidateAllSessions(accountId: string): Promise<void> {
      await deleteSessionsForAccount(db, accountId)
    },

    async invalidateOtherSessions(accountId: string, exceptSessionId: string): Promise<void> {
      await deleteOtherSessionsForAccount(db, accountId, exceptSessionId)
    },

    async verifyAccountPassword(accountId: string, password: string): Promise<boolean> {
      const account = await getAccountById(db, accountId)
      if (!account) return false
      return verifyPassword(password, account.password_hash)
    },

    worldsBlockingDeletion(accountId: string): Promise<BlockingWorld[]> {
      return worldsBlockingDeletion(db, accountId)
    },

    deleteAccount(accountId: string): Promise<void> {
      return deleteAccount(db, accountId)
    },

    async setUsername(accountId: string, username: string): Promise<PublicAccount> {
      // Same gate as creation: reject the taken name up front, and let the DB's
      // unique index be the backstop for a concurrent race.
      const existing = await getAccountByUsername(db, username)
      // Renaming to a name that resolves to YOU is allowed — which, now that
      // the comparison folds case (0009), is what lets someone re-capitalise
      // their own name (`sophi` -> `Sophi`) instead of being told it is taken.
      if (existing && existing.id !== accountId) throw new DuplicateUsernameError(username)
      await setAccountUsername(db, accountId, username)
      return { id: accountId, username }
    },

    async rotateSession(
      accountId: string,
      currentSessionId: string,
      meta?: SessionMeta,
    ): Promise<string> {
      const sessionId = await openSession(accountId, meta)
      await deleteSession(db, currentSessionId)
      return sessionId
    },

    async listSessions(accountId: string, currentSessionId: string): Promise<SessionSummary[]> {
      const at = now()
      await deleteExpiredSessionsForAccount(db, accountId, at)
      const rows = await listSessionsForAccount(db, accountId, at)
      return rows.map((row) => ({
        createdAt: row.created_at,
        lastSeenAt: row.last_seen_at,
        deviceLabel: row.device_label,
        current: row.id === currentSessionId,
      }))
    },
  }
}
