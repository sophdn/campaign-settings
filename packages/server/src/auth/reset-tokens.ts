import type { Kysely } from 'kysely'
import { newId } from '../db/ids'
import type { Database } from '../db/schema'
import { hashToken, newToken } from './tokens'

/**
 * Issue a single-use reset token for an account and return the RAW secret — the
 * only moment it exists in the clear (it goes straight into the emailed link).
 *
 * - Invalidates any outstanding tokens for the account: a new request supersedes
 *   old ones.
 * - Throttled: if an unconsumed token was created within `throttleMs` of `now`,
 *   returns null WITHOUT issuing a new one, so a hammered endpoint cannot
 *   mail-bomb an address.
 */
export async function createResetToken(
  db: Kysely<Database>,
  accountId: string,
  now: Date,
  ttlMs: number,
  throttleMs: number,
): Promise<string | null> {
  const recent = await db
    .selectFrom('password_reset_tokens')
    .select('id')
    .where('account_id', '=', accountId)
    .where('consumed_at', 'is', null)
    .where('created_at', '>', new Date(now.getTime() - throttleMs))
    .executeTakeFirst()
  if (recent) return null

  await db.deleteFrom('password_reset_tokens').where('account_id', '=', accountId).execute()
  const raw = newToken()
  await db
    .insertInto('password_reset_tokens')
    .values({
      id: newId(),
      account_id: accountId,
      token_hash: hashToken(raw),
      expires_at: new Date(now.getTime() + ttlMs),
      created_at: now,
    })
    .execute()
  return raw
}

/**
 * Consume a reset token: return its account id iff the token exists, is
 * unconsumed, and has not expired at `now`, marking it consumed in the process.
 * Returns null otherwise (unknown, already used, or expired) — the caller maps
 * every null to the same opaque error.
 */
export async function consumeResetToken(
  db: Kysely<Database>,
  raw: string,
  now: Date,
): Promise<string | null> {
  const row = await db
    .selectFrom('password_reset_tokens')
    .select(['id', 'account_id', 'expires_at', 'consumed_at'])
    .where('token_hash', '=', hashToken(raw))
    .executeTakeFirst()
  if (!row || row.consumed_at !== null || row.expires_at <= now) return null
  await db
    .updateTable('password_reset_tokens')
    .set({ consumed_at: now })
    .where('id', '=', row.id)
    .execute()
  return row.account_id
}
