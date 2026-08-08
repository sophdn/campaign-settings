import { type Kysely, type Selectable, type SqlBool, sql } from 'kysely'
import type { AccountsTable, Database } from '../db/schema'

/**
 * Accounts are GLOBAL (not world-scoped) — they pre-exist any world, so this
 * repo takes a bare `Kysely`, unlike the world-scoped entity repos that take a
 * `WorldContext`. World membership/tenancy layers on later (tenancy task).
 */

export type AccountRow = Selectable<AccountsTable>

export async function insertAccount(
  db: Kysely<Database>,
  row: { id: string; username: string; password_hash: string; email?: string | null },
): Promise<void> {
  await db.insertInto('accounts').values(row).execute()
}

/**
 * Case-INSENSITIVE username lookup (0009). This is the single door every
 * username comparison goes through — login, the duplicate check on create and
 * rename, the password-reset identifier, and the member lookup — so folding
 * case here is what makes `sophi` and `SophI` one account everywhere at once.
 * The stored capitalisation is untouched; only the comparison folds.
 */
export function getAccountByUsername(
  db: Kysely<Database>,
  username: string,
): Promise<AccountRow | undefined> {
  return db
    .selectFrom('accounts')
    .selectAll()
    .where(sql<SqlBool>`lower(username) = ${username.toLowerCase()}`)
    .executeTakeFirst()
}

export function getAccountById(db: Kysely<Database>, id: string): Promise<AccountRow | undefined> {
  return db.selectFrom('accounts').selectAll().where('id', '=', id).executeTakeFirst()
}

/** Overwrite an account's chosen login name. Uniqueness is the caller's gate. */
export async function setAccountUsername(
  db: Kysely<Database>,
  accountId: string,
  username: string,
): Promise<void> {
  await db.updateTable('accounts').set({ username }).where('id', '=', accountId).execute()
}

/** Overwrite an account's stored password hash. */
export async function setAccountPassword(
  db: Kysely<Database>,
  accountId: string,
  passwordHash: string,
): Promise<void> {
  await db
    .updateTable('accounts')
    .set({ password_hash: passwordHash })
    .where('id', '=', accountId)
    .execute()
}

/** Case-insensitive email lookup. NULL-email rows never match (lower(null) is null). */
export function getAccountByEmail(
  db: Kysely<Database>,
  email: string,
): Promise<AccountRow | undefined> {
  return db
    .selectFrom('accounts')
    .selectAll()
    .where(sql<SqlBool>`lower(email) = ${email.toLowerCase()}`)
    .executeTakeFirst()
}
