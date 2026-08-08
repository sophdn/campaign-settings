import { type Kysely, sql } from 'kysely'

/**
 * Email verification: a timestamp on the account plus a token table shaped
 * exactly like `password_reset_tokens` (0007) — hashed at rest, expiring,
 * single-use — because they are the same problem and should not drift apart.
 *
 * `email_verified_at` is a TIMESTAMP, not a boolean. "When" answers "whether"
 * for free, and a bare flag would leave us unable to answer the first question
 * the day someone asks it. NULL means unverified, which is every account that
 * exists before this migration — including the operator-CLI accounts that have
 * no email at all and never can be verified.
 *
 * That last point is why verification gates only world creation and invitation,
 * never login (the recorded decision from decide-account-identity-model): the
 * live owner account was minted by the CLI with no email, and a login gate would
 * lock the operator out of their own instance on deploy.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('accounts').addColumn('email_verified_at', 'timestamptz').execute()

  await db.schema
    .createTable('email_verification_tokens')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('account_id', 'text', (c) =>
      c.notNull().references('accounts.id').onDelete('cascade'),
    )
    .addColumn('token_hash', 'text', (c) => c.notNull().unique())
    .addColumn('expires_at', 'timestamptz', (c) => c.notNull())
    .addColumn('consumed_at', 'timestamptz')
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .execute()

  await db.schema
    .createIndex('email_verification_tokens_account_idx')
    .on('email_verification_tokens')
    .column('account_id')
    .execute()
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('email_verification_tokens').execute()
  await db.schema.alterTable('accounts').dropColumn('email_verified_at').execute()
}
