import { type Kysely, sql } from 'kysely'

/**
 * Password reset tokens: one-time, short-lived credentials for the
 * forgot-password flow. Only the SHA-256 HASH of the token is stored — the raw
 * secret exists only in transit (the emailed link). `consumed_at` makes a token
 * single-use; expiry is enforced by the consumer against the request clock. The
 * FK cascade drops a deleted account's tokens with it.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('password_reset_tokens')
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
    .createIndex('password_reset_tokens_account_idx')
    .on('password_reset_tokens')
    .column('account_id')
    .execute()
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('password_reset_tokens').execute()
}
