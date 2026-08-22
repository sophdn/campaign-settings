import { type Kysely, sql } from 'kysely'

/**
 * Add a nullable `email` column to accounts, with case-insensitive uniqueness
 * that tolerates NULL. Additive and non-breaking: accounts created by the
 * operator CLI before this migration (the live owner account) keep working with
 * a NULL email. Recovery, verification, and invitation flows layer on later —
 * this migration lands only the contact channel the account model needs.
 *
 * Uniqueness is a PARTIAL unique index on lower(email) WHERE email IS NOT NULL,
 * so two accounts can never share an address differing only in case, while any
 * number of accounts may have no email at all.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('accounts').addColumn('email', 'text').execute()
  await sql`create unique index accounts_email_lower_unique on accounts (lower(email)) where email is not null`.execute(
    db,
  )
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop index if exists accounts_email_lower_unique`.execute(db)
  await db.schema.alterTable('accounts').dropColumn('email').execute()
}
