import { type Kysely, type SqlBool, sql } from 'kysely'
import { newId } from '../db/ids'
import type { Database } from '../db/schema'
import { hashToken, newToken } from './tokens'

/**
 * Email verification tokens. Deliberately the same shape as `reset-tokens.ts`
 * — hashed at rest via the shared `tokens.ts` primitives, single-use, expiring,
 * throttled — because they are the same problem, and two near-identical token
 * flows that drift apart is how one of them ends up weaker than the other.
 */

/**
 * Issue a single-use verification token and return the RAW secret, or null if
 * one was issued within `throttleMs` (the resend guard: an unthrottled resend
 * is a mail-bomb aimed at whatever address the account claims).
 *
 * A new token supersedes any outstanding one, so a user who clicks resend and
 * then finds the older mail is told the link is dead rather than being let
 * through by a token they had already replaced.
 */
export async function createVerificationToken(
  db: Kysely<Database>,
  accountId: string,
  now: Date,
  ttlMs: number,
  throttleMs: number,
): Promise<string | null> {
  const recent = await db
    .selectFrom('email_verification_tokens')
    .select('id')
    .where('account_id', '=', accountId)
    .where('consumed_at', 'is', null)
    .where('created_at', '>', new Date(now.getTime() - throttleMs))
    .executeTakeFirst()
  if (recent) return null

  await db.deleteFrom('email_verification_tokens').where('account_id', '=', accountId).execute()
  const raw = newToken()
  await db
    .insertInto('email_verification_tokens')
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
 * Consume a verification token and stamp the account verified, in one
 * transaction. Returns the account id, or null for every refusal alike —
 * unknown, already used, expired — because the caller maps them to one opaque
 * error and distinguishing them would turn a dead link into an oracle.
 *
 * Consuming an already-verified account's token is harmless and simply
 * re-stamps it: a user who clicks the link twice should not see a failure for
 * having done the right thing.
 */
export async function consumeVerificationToken(
  db: Kysely<Database>,
  raw: string,
  now: Date,
): Promise<string | null> {
  return db.transaction().execute(async (trx) => {
    const row = await trx
      .selectFrom('email_verification_tokens')
      .select(['id', 'account_id', 'expires_at', 'consumed_at'])
      .where('token_hash', '=', hashToken(raw))
      .executeTakeFirst()
    if (!row || row.consumed_at !== null || row.expires_at <= now) return null
    await trx
      .updateTable('email_verification_tokens')
      .set({ consumed_at: now })
      .where('id', '=', row.id)
      .execute()
    await trx
      .updateTable('accounts')
      .set({ email_verified_at: now })
      .where('id', '=', row.account_id)
      .execute()
    return row.account_id
  })
}

/**
 * Whether this account still has an address to prove.
 *
 * TRUE only when the account HAS an email and has not verified it. An account
 * with NO email is not "unverified" — it has nothing to prove. That is not a
 * loophole: `POST /api/register` requires an address, so the only way to hold an
 * emailless account is to have been minted by `scripts/create-account.mts`,
 * which requires shell access on the host. An operator with a shell is trusted
 * by that fact, and this is what keeps the live owner account — created before
 * 0006 added the column — able to run its own instance after this migration.
 *
 * Gating on this rather than on `email_verified_at` alone is the difference
 * between "verification gates world creation" and "deploying this locks the
 * operator out of their own server".
 */
export async function isVerificationOutstanding(
  db: Kysely<Database>,
  accountId: string,
): Promise<boolean> {
  const row = await db
    .selectFrom('accounts')
    .select(['email', 'email_verified_at'])
    .where('id', '=', accountId)
    .executeTakeFirst()
  if (!row) return false
  return row.email !== null && row.email_verified_at == null
}

/**
 * Raised when an unverified account attempts a gated action. Names the action
 * so the message is actionable rather than a bare "not allowed".
 */
export class EmailNotVerifiedError extends Error {
  constructor(action: string) {
    super(`verify your email address before you can ${action}`)
    this.name = 'EmailNotVerifiedError'
  }
}

/**
 * Outcome of {@link debugVerifyAccount}, discriminated so a caller reports what
 * actually happened instead of inferring it from a boolean. "Nothing changed"
 * has three different causes here and they are not interchangeable.
 */
export type DebugVerifyResult =
  | { status: 'verified'; accountId: string; username: string; email: string; at: Date }
  | { status: 'already-verified'; accountId: string; username: string; email: string; at: Date }
  | { status: 'no-email'; accountId: string; username: string }
  | { status: 'no-such-account'; username: string }

/**
 * Operator escape hatch: stamp an account verified WITHOUT the emailed round
 * trip, for local and dummy setups that have no outbound mail path.
 *
 * WHY THIS IS NOT A HOLE, AND WHAT KEEPS IT THAT WAY. This is a library
 * function whose only caller is `scripts/debug-verify-account.mts`, which
 * requires a shell on the host. There is deliberately NO HTTP route, and no
 * feature flag that would add one. That is the same trust boundary
 * `create-account.mts` already stands on, and the one `isVerificationOutstanding`
 * names above: an operator with a shell is trusted by that fact.
 *
 * Do NOT wire this to a route, flag-gated or otherwise. Verification exists so
 * that holding an address is proven rather than claimed; an endpoint that skips
 * the proof turns the whole mechanism into an honour system, and a flag that
 * defaults off is one misconfigured deploy away from being on.
 *
 * Refuses rather than pretends:
 *  - an account with no address has nothing to prove, and stamping
 *    `email_verified_at` on it would assert something false. It is also already
 *    ungated (see `isVerificationOutstanding`), so there is nothing to fix.
 *  - an unknown username is reported, never silently treated as success.
 *
 * Idempotent: re-running against a verified account leaves the original
 * timestamp alone, because when it was verified is the answer to whether, and
 * rewriting history to "just now" would lose that.
 *
 * Any outstanding token is deleted, so a link already sitting in an inbox
 * cannot be replayed after the account was verified by other means.
 */
export async function debugVerifyAccount(
  db: Kysely<Database>,
  username: string,
  now: Date = new Date(),
): Promise<DebugVerifyResult> {
  return db.transaction().execute(async (trx) => {
    const account = await trx
      .selectFrom('accounts')
      .select(['id', 'username', 'email', 'email_verified_at'])
      .where(sql<SqlBool>`lower(username) = ${username.toLowerCase()}`)
      .executeTakeFirst()

    if (!account) return { status: 'no-such-account', username }
    if (account.email === null) {
      return { status: 'no-email', accountId: account.id, username: account.username }
    }

    await trx.deleteFrom('email_verification_tokens').where('account_id', '=', account.id).execute()

    if (account.email_verified_at != null) {
      return {
        status: 'already-verified',
        accountId: account.id,
        username: account.username,
        email: account.email,
        at: account.email_verified_at,
      }
    }

    await trx
      .updateTable('accounts')
      .set({ email_verified_at: now })
      .where('id', '=', account.id)
      .execute()

    return {
      status: 'verified',
      accountId: account.id,
      username: account.username,
      email: account.email,
      at: now,
    }
  })
}
