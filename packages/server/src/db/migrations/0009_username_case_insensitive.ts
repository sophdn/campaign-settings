import { type Kysely, sql } from 'kysely'

/**
 * Make usernames case-INSENSITIVELY unique, closing the gap where `Sophi` and
 * `sophi` were two separate, separately-loggable accounts.
 *
 * Migration 0006 already gave `email` this treatment (partial unique index on
 * `lower(email)`); `username` was left with the plain UNIQUE from 0001, so the
 * two identity columns disagreed about what "the same" means. On a public
 * instance that difference is an impersonation vector: register the case
 * variant of someone's name and the two are near-indistinguishable in any list
 * that renders usernames.
 *
 * Stored capitalisation is PRESERVED — people choose how their name looks and
 * it should display as they typed it. Only uniqueness and lookup fold case,
 * exactly as email does.
 *
 * The plain UNIQUE(username) from 0001 is deliberately left in place. It is
 * implied by this index and costs one small index on a tiny table, and it is
 * the constraint the service code names as its concurrent-race backstop —
 * dropping a constraint from the initial migration to shave a redundant index
 * is a reversibility risk with no functional gain.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  // Refuse rather than choose. If two accounts already collide, resolving it
  // means renaming somebody — changing a real person's login key — and that is
  // an operator's decision, not a migration's. Migrations run on boot, so this
  // throw is loud by design: the service will not start until it is resolved,
  // which is the correct outcome for "two accounts may be the same person".
  const collisions = await sql<{ folded: string; names: string }>`
    select lower(username) as folded,
           string_agg(username, ', ' order by username) as names
      from accounts
     group by lower(username)
    having count(*) > 1
  `.execute(db)

  if (collisions.rows.length > 0) {
    const detail = collisions.rows.map((r) => `${r.folded} -> ${r.names}`).join('; ')
    throw new Error(
      `cannot make usernames case-insensitively unique: ${collisions.rows.length} name(s) already collide (${detail}). ` +
        'Rename one account in each group, then start again. This migration will not pick which one to rename.',
    )
  }

  await sql`create unique index accounts_username_lower_unique on accounts (lower(username))`.execute(
    db,
  )
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop index if exists accounts_username_lower_unique`.execute(db)
}
